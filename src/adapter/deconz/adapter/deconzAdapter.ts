/* istanbul ignore file */

import assert from 'assert';

import {ZSpec} from '../../..';
import Device from '../../../controller/model/device';
import * as Models from '../../../models';
import {Queue, Waitress} from '../../../utils';
import {logger} from '../../../utils/logger';
import {BroadcastAddress} from '../../../zspec/enums';
import * as Zcl from '../../../zspec/zcl';
import * as Zdo from '../../../zspec/zdo';
import {SimpleDescriptorResponse} from '../../../zspec/zdo/definition/tstypes';
import Adapter from '../../adapter';
import * as Events from '../../events';
import {AdapterOptions, Coordinator, CoordinatorVersion, NetworkOptions, NetworkParameters, SerialPortOptions, StartResult} from '../../tstype';
import PARAM, {ApsDataRequest, gpDataInd, ReceivedDataResponse, WaitForDataRequest} from '../driver/constants';
import Driver from '../driver/driver';
import processFrame, {frameParserEvents} from '../driver/frameParser';

const NS = 'zh:deconz';

interface WaitressMatcher {
    address?: number | string;
    endpoint: number;
    transactionSequenceNumber?: number;
    frameType: Zcl.FrameType;
    clusterID: number;
    commandIdentifier: number;
    direction: number;
}

class DeconzAdapter extends Adapter {
    private driver: Driver;
    private queue: Queue;
    private openRequestsQueue: WaitForDataRequest[];
    private transactionID: number;
    private frameParserEvent = frameParserEvents;
    private joinPermitted: boolean;
    private fwVersion?: CoordinatorVersion;
    private waitress: Waitress<Events.ZclPayload, WaitressMatcher>;
    private TX_OPTIONS = 0x00; // No APS ACKS

    public constructor(networkOptions: NetworkOptions, serialPortOptions: SerialPortOptions, backupPath: string, adapterOptions: AdapterOptions) {
        super(networkOptions, serialPortOptions, backupPath, adapterOptions);

        const concurrent = this.adapterOptions && this.adapterOptions.concurrent ? this.adapterOptions.concurrent : 2;

        // TODO: https://github.com/Koenkk/zigbee2mqtt/issues/4884#issuecomment-728903121
        const delay = this.adapterOptions && typeof this.adapterOptions.delay === 'number' ? this.adapterOptions.delay : 0;

        this.waitress = new Waitress<Events.ZclPayload, WaitressMatcher>(this.waitressValidator, this.waitressTimeoutFormatter);

        this.driver = new Driver(serialPortOptions.path!);
        this.driver.setDelay(delay);

        if (delay >= 200) {
            this.TX_OPTIONS = 0x04; // activate APS ACKS
        }

        this.driver.on('rxFrame', (frame) => {
            processFrame(frame);
        });
        this.queue = new Queue(concurrent);
        this.transactionID = 0;
        this.openRequestsQueue = [];
        this.joinPermitted = false;
        this.fwVersion = undefined;

        this.frameParserEvent.on('receivedDataPayload', (data) => {
            this.checkReceivedDataPayload(data);
        });
        this.frameParserEvent.on('receivedGreenPowerIndication', (data) => {
            this.checkReceivedGreenPowerIndication(data);
        });

        setInterval(() => {
            this.checkReceivedDataPayload(null);
        }, 1000);
        setTimeout(async () => {
            await this.checkCoordinatorSimpleDescriptor(false);
        }, 3000);
    }

    public static async isValidPath(path: string): Promise<boolean> {
        return Driver.isValidPath(path);
    }

    public static async autoDetectPath(): Promise<string | undefined> {
        return Driver.autoDetectPath();
    }

    /**
     * Adapter methods
     */
    public async start(): Promise<StartResult> {
        const baudrate = this.serialPortOptions.baudRate || 38400;
        await this.driver.open(baudrate);

        let changed: boolean = false;
        const panid = await this.driver.readParameterRequest(PARAM.PARAM.Network.PAN_ID);
        const expanid = await this.driver.readParameterRequest(PARAM.PARAM.Network.APS_EXT_PAN_ID);
        const channel = await this.driver.readParameterRequest(PARAM.PARAM.Network.CHANNEL);
        const networkKey = await this.driver.readParameterRequest(PARAM.PARAM.Network.NETWORK_KEY);

        // check current channel against configuration.yaml
        if (this.networkOptions.channelList[0] !== channel) {
            logger.debug(
                'Channel in configuration.yaml (' +
                    this.networkOptions.channelList[0] +
                    ') differs from current channel (' +
                    channel +
                    '). Changing channel.',
                NS,
            );

            let setChannelMask = 0;
            switch (this.networkOptions.channelList[0]) {
                case 11:
                    setChannelMask = 0x800;
                    break;
                case 12:
                    setChannelMask = 0x1000;
                    break;
                case 13:
                    setChannelMask = 0x2000;
                    break;
                case 14:
                    setChannelMask = 0x4000;
                    break;
                case 15:
                    setChannelMask = 0x8000;
                    break;
                case 16:
                    setChannelMask = 0x10000;
                    break;
                case 17:
                    setChannelMask = 0x20000;
                    break;
                case 18:
                    setChannelMask = 0x40000;
                    break;
                case 19:
                    setChannelMask = 0x80000;
                    break;
                case 20:
                    setChannelMask = 0x100000;
                    break;
                case 21:
                    setChannelMask = 0x200000;
                    break;
                case 22:
                    setChannelMask = 0x400000;
                    break;
                case 23:
                    setChannelMask = 0x800000;
                    break;
                case 24:
                    setChannelMask = 0x1000000;
                    break;
                case 25:
                    setChannelMask = 0x2000000;
                    break;
                case 26:
                    setChannelMask = 0x4000000;
                    break;
                default:
                    break;
            }

            try {
                await this.driver.writeParameterRequest(PARAM.PARAM.Network.CHANNEL_MASK, setChannelMask);
                await this.sleep(500);
                changed = true;
            } catch (error) {
                logger.debug('Could not set channel: ' + error, NS);
            }
        }

        // check current panid against configuration.yaml
        if (this.networkOptions.panID !== panid) {
            logger.debug(
                'panid in configuration.yaml (' + this.networkOptions.panID + ') differs from current panid (' + panid + '). Changing panid.',
                NS,
            );

            try {
                await this.driver.writeParameterRequest(PARAM.PARAM.Network.PAN_ID, this.networkOptions.panID);
                await this.sleep(500);
                changed = true;
            } catch (error) {
                logger.debug('Could not set panid: ' + error, NS);
            }
        }

        // check current extended_panid against configuration.yaml
        if (this.driver.generalArrayToString(this.networkOptions.extendedPanID!, 8) !== expanid) {
            logger.debug(
                'extended panid in configuration.yaml (' +
                    this.driver.macAddrArrayToString(this.networkOptions.extendedPanID!) +
                    ') differs from current extended panid (' +
                    expanid +
                    '). Changing extended panid.',
                NS,
            );

            try {
                await this.driver.writeParameterRequest(PARAM.PARAM.Network.APS_EXT_PAN_ID, this.networkOptions.extendedPanID!);
                await this.sleep(500);
                changed = true;
            } catch (error) {
                logger.debug('Could not set extended panid: ' + error, NS);
            }
        }

        // check current network key against configuration.yaml
        if (this.driver.generalArrayToString(this.networkOptions.networkKey!, 16) !== networkKey) {
            logger.debug(
                'network key in configuration.yaml (hidden) differs from current network key (' + networkKey + '). Changing network key.',
                NS,
            );

            try {
                await this.driver.writeParameterRequest(PARAM.PARAM.Network.NETWORK_KEY, this.networkOptions.networkKey!);
                await this.sleep(500);
                changed = true;
            } catch (error) {
                logger.debug('Could not set network key: ' + error, NS);
            }
        }

        if (changed) {
            await this.driver.changeNetworkStateRequest(PARAM.PARAM.Network.NET_OFFLINE);
            await this.sleep(2000);
            await this.driver.changeNetworkStateRequest(PARAM.PARAM.Network.NET_CONNECTED);
            await this.sleep(2000);
        }

        return 'resumed';
    }

    public async stop(): Promise<void> {
        await this.driver.close();
    }

    public async getCoordinator(): Promise<Coordinator> {
        const ieeeAddr = await this.driver.readParameterRequest(PARAM.PARAM.Network.MAC);
        const nwkAddr = await this.driver.readParameterRequest(PARAM.PARAM.Network.NWK_ADDRESS);

        const endpoints = [
            {
                ID: 0x01,
                profileID: 0x0104,
                deviceID: 0x0005,
                inputClusters: [0x0000, 0x0006, 0x000a, 0x0019, 0x0501],
                outputClusters: [0x0001, 0x0020, 0x0500, 0x0502],
            },
            {
                ID: 0xf2,
                profileID: 0xa1e0,
                deviceID: 0x0064,
                inputClusters: [],
                outputClusters: [0x0021],
            },
        ];

        return {
            networkAddress: nwkAddr as number,
            manufacturerID: 0x1135,
            ieeeAddr: ieeeAddr as string,
            endpoints,
        };
    }

    public async permitJoin(seconds: number, networkAddress?: number): Promise<void> {
        // TODO: logic reworked to match other stack (proper dropdown support), needs verifying
        if (networkAddress) {
            // `authentication`: TC significance always 1 (zb specs)
            const zdoPayload = Zdo.Buffalo.buildRequest(Zdo.ClusterId.PERMIT_JOINING_REQUEST, this.hasZdoMessageOverhead, seconds, 1, []);

            await this.sendZdo(ZSpec.BLANK_EUI64, networkAddress, Zdo.ClusterId.PERMIT_JOINING_REQUEST, zdoPayload, false);
        } else {
            // TODO: assuming this is permit join on coordinator?
            await this.driver.writeParameterRequest(PARAM.PARAM.Network.PERMIT_JOIN, seconds);

            // broadcast permit joining ZDO
            if (networkAddress === undefined) {
                // `authentication`: TC significance always 1 (zb specs)
                const zdoPayload = Zdo.Buffalo.buildRequest(Zdo.ClusterId.PERMIT_JOINING_REQUEST, this.hasZdoMessageOverhead, seconds, 1, []);

                await this.sendZdo(ZSpec.BLANK_EUI64, ZSpec.BroadcastAddress.DEFAULT, Zdo.ClusterId.PERMIT_JOINING_REQUEST, zdoPayload, true);
            }
        }

        if (seconds === 0) {
            this.joinPermitted = false;
        } else {
            this.joinPermitted = true;
        }
    }

    public async getCoordinatorVersion(): Promise<CoordinatorVersion> {
        // product: number; transportrev: number; majorrel: number; minorrel: number; maintrel: number; revision: string;
        if (this.fwVersion != undefined) {
            return this.fwVersion;
        } else {
            try {
                const fw = await this.driver.readFirmwareVersionRequest();
                const buf = Buffer.from(fw);
                const fwString = '0x' + buf.readUInt32LE(0).toString(16);
                let type: string = '';
                if (fw[1] === 5) {
                    type = 'ConBee/RaspBee';
                } else if (fw[1] === 7) {
                    type = 'ConBee2/RaspBee2';
                } else {
                    type = 'ConBee3';
                }
                const meta = {transportrev: 0, product: 0, majorrel: fw[3], minorrel: fw[2], maintrel: 0, revision: fwString};
                this.fwVersion = {type: type, meta: meta};
                return {type: type, meta: meta};
            } catch (error) {
                throw new Error('Get coordinator version Error: ' + error);
            }
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async addInstallCode(ieeeAddress: string, key: Buffer): Promise<void> {
        return Promise.reject(new Error('Add install code is not supported'));
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async reset(type: 'soft' | 'hard'): Promise<void> {
        return Promise.reject(new Error('Reset is not supported'));
    }

    private async checkCoordinatorSimpleDescriptor(skip: boolean): Promise<void> {
        logger.debug('checking coordinator simple descriptor', NS);
        let simpleDesc: SimpleDescriptorResponse | undefined;

        if (skip === false) {
            try {
                const clusterId = Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST;
                const zdoPayload = Zdo.Buffalo.buildRequest(clusterId, this.hasZdoMessageOverhead, ZSpec.COORDINATOR_ADDRESS, 1);
                simpleDesc = await this.sendZdo<SimpleDescriptorResponse>(
                    ZSpec.BLANK_EUI64 /* unused */,
                    ZSpec.COORDINATOR_ADDRESS,
                    clusterId,
                    zdoPayload,
                    false,
                );
            } catch {
                /* empty */
            }

            if (simpleDesc == undefined) {
                await this.checkCoordinatorSimpleDescriptor(false);
                return;
            }

            logger.debug('EP: ' + simpleDesc.endpoint, NS);
            logger.debug('profile ID: ' + simpleDesc.profileId, NS);
            logger.debug('device ID: ' + simpleDesc.deviceId, NS);

            for (let i = 0; i < simpleDesc.inClusterList.length; i++) {
                logger.debug('input cluster: 0x' + simpleDesc.inClusterList[i].toString(16), NS);
            }

            for (let o = 0; o < simpleDesc.outClusterList.length; o++) {
                logger.debug('output cluster: 0x' + simpleDesc.outClusterList[o].toString(16), NS);
            }

            let ok = true;

            if (simpleDesc.endpoint === 0x1) {
                if (
                    !simpleDesc.inClusterList.includes(0x0) ||
                    !simpleDesc.inClusterList.includes(0x0a) ||
                    !simpleDesc.inClusterList.includes(0x06) ||
                    !simpleDesc.inClusterList.includes(0x19) ||
                    !simpleDesc.inClusterList.includes(0x0501) ||
                    !simpleDesc.outClusterList.includes(0x01) ||
                    !simpleDesc.outClusterList.includes(0x20) ||
                    !simpleDesc.outClusterList.includes(0x500) ||
                    !simpleDesc.outClusterList.includes(0x502)
                ) {
                    logger.debug('missing cluster', NS);
                    ok = false;
                }

                if (ok === true) {
                    return;
                }
            }
        }

        logger.debug('setting new simple descriptor', NS);

        try {
            //[ sd1   ep    proId       devId       vers  #inCl iCl1        iCl2        iCl3        iCl4        iCl5        #outC oCl1        oCl2        oCl3        oCl4      ]
            const sd = [
                0x00, 0x01, 0x04, 0x01, 0x05, 0x00, 0x01, 0x05, 0x00, 0x00, 0x00, 0x06, 0x0a, 0x00, 0x19, 0x00, 0x01, 0x05, 0x04, 0x01, 0x00, 0x20,
                0x00, 0x00, 0x05, 0x02, 0x05,
            ];
            const sd1 = sd.reverse();

            await this.driver.writeParameterRequest(PARAM.PARAM.STK.Endpoint, sd1);
        } catch (error) {
            logger.debug(`error setting simple descriptor: ${error} - try again`, NS);
            await this.checkCoordinatorSimpleDescriptor(true);

            return;
        }

        logger.debug('success setting simple descriptor', NS);
    }

    public waitFor(
        networkAddress: number | undefined,
        endpoint: number,
        frameType: Zcl.FrameType,
        direction: Zcl.Direction,
        transactionSequenceNumber: number | undefined,
        clusterID: number,
        commandIdentifier: number,
        timeout: number,
    ): {promise: Promise<Events.ZclPayload>; cancel: () => void} {
        const payload = {
            address: networkAddress,
            endpoint,
            clusterID,
            commandIdentifier,
            frameType,
            direction,
            transactionSequenceNumber,
        };
        const waiter = this.waitress.waitFor(payload, timeout);
        const cancel = (): void => this.waitress.remove(waiter.ID);
        return {promise: waiter.start().promise, cancel};
    }

    public async sendZclFrameToEndpoint(
        ieeeAddr: string,
        networkAddress: number,
        endpoint: number,
        zclFrame: Zcl.Frame,
        timeout: number,
        disableResponse: boolean,
        disableRecovery: boolean,
        sourceEndpoint?: number,
    ): Promise<Events.ZclPayload | void> {
        const transactionID = this.nextTransactionID();
        const request: ApsDataRequest = {};

        const pay = zclFrame.toBuffer();
        //logger.info("zclFramte.toBuffer:", NS);
        //logger.info(pay, NS);

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = networkAddress;
        request.destEndpoint = endpoint;
        request.profileId = sourceEndpoint === 242 && endpoint === 242 ? 0xa1e0 : 0x104;
        request.clusterId = zclFrame.cluster.ID;
        request.srcEndpoint = sourceEndpoint || 1;
        request.asduLength = pay.length;
        request.asduPayload = [...pay];
        request.txOptions = this.TX_OPTIONS; // 0x00 normal; 0x04 APS ACK
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
        request.timeout = timeout;

        const command = zclFrame.command;

        this.driver
            .enqueueSendDataRequest(request)
            .then(() => {
                logger.debug(`sendZclFrameToEndpoint - message send with transSeq Nr.: ${zclFrame.header.transactionSequenceNumber}`, NS);
                logger.debug(
                    (command.response !== undefined) +
                        ', ' +
                        zclFrame.header.frameControl.disableDefaultResponse +
                        ', ' +
                        disableResponse +
                        ', ' +
                        request.timeout,
                    NS,
                );

                if (command.response == undefined || zclFrame.header.frameControl.disableDefaultResponse || !disableResponse) {
                    logger.debug(`resolve request (${zclFrame.header.transactionSequenceNumber})`, NS);
                    return Promise.resolve();
                }
            })
            .catch((error) => {
                logger.debug(`sendZclFrameToEndpoint ERROR (${zclFrame.header.transactionSequenceNumber})`, NS);
                logger.debug(error, NS);
                //return Promise.reject(new Error("sendZclFrameToEndpoint ERROR " + error));
            });

        try {
            let data = null;
            if ((command.response != undefined && !disableResponse) || !zclFrame.header.frameControl.disableDefaultResponse) {
                data = await this.waitForData(networkAddress, 0x104, zclFrame.cluster.ID, zclFrame.header.transactionSequenceNumber, request.timeout);
            }

            if (data !== null) {
                const asdu = data.asduPayload!;
                const buffer = Buffer.from(asdu);

                const response: Events.ZclPayload = {
                    address: data.srcAddr16 ?? `0x${data.srcAddr64!}`,
                    data: buffer,
                    clusterID: zclFrame.cluster.ID,
                    header: Zcl.Header.fromBuffer(buffer),
                    endpoint: data.srcEndpoint!,
                    linkquality: data.lqi!,
                    groupID: data.srcAddrMode === 0x01 ? data.srcAddr16! : 0,
                    wasBroadcast: data.srcAddrMode === 0x01 || data.srcAddrMode === 0xf,
                    destinationEndpoint: data.destEndpoint!,
                };
                logger.debug(`response received (${zclFrame.header.transactionSequenceNumber})`, NS);
                return response;
            } else {
                logger.debug(`no response expected (${zclFrame.header.transactionSequenceNumber})`, NS);
            }
        } catch (error) {
            throw new Error(`no response received (${zclFrame.header.transactionSequenceNumber}) ${error}`);
        }
    }

    public async sendZclFrameToGroup(groupID: number, zclFrame: Zcl.Frame): Promise<void> {
        const transactionID = this.nextTransactionID();
        const request: ApsDataRequest = {};
        const pay = zclFrame.toBuffer();

        logger.debug('zclFrame to group - zclFrame.payload:', NS);
        logger.debug(zclFrame.payload, NS);
        //logger.info("zclFramte.toBuffer:", NS);
        //logger.info(pay, NS);

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.GROUP_ADDR;
        request.destAddr16 = groupID;
        request.profileId = 0x104;
        request.clusterId = zclFrame.cluster.ID;
        request.srcEndpoint = 1;
        request.asduLength = pay.length;
        request.asduPayload = [...pay];
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.UNLIMITED;

        logger.debug(`sendZclFrameToGroup - message send`, NS);
        return this.driver.enqueueSendDataRequest(request) as Promise<void>;
    }

    public async sendZclFrameToAll(endpoint: number, zclFrame: Zcl.Frame, sourceEndpoint: number, destination: BroadcastAddress): Promise<void> {
        const transactionID = this.nextTransactionID();
        const request: ApsDataRequest = {};
        const pay = zclFrame.toBuffer();

        logger.debug('zclFrame to all - zclFrame.payload:', NS);
        logger.debug(zclFrame.payload, NS);

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = destination;
        request.destEndpoint = endpoint;
        request.profileId = sourceEndpoint === 242 && endpoint === 242 ? 0xa1e0 : 0x104;
        request.clusterId = zclFrame.cluster.ID;
        request.srcEndpoint = sourceEndpoint;
        request.asduLength = pay.length;
        request.asduPayload = [...pay];
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.UNLIMITED;

        logger.debug(`sendZclFrameToAll - message send`, NS);
        return this.driver.enqueueSendDataRequest(request) as Promise<void>;
    }

    public async sendZdo(
        ieeeAddress: string,
        networkAddress: number,
        clusterId: Zdo.ClusterId,
        payload: Buffer,
        disableResponse: boolean,
    ): Promise<void>;
    public async sendZdo<T>(
        ieeeAddress: string,
        networkAddress: number,
        clusterId: Zdo.ClusterId,
        payload: Buffer,
        disableResponse: boolean,
    ): Promise<T>;
    public async sendZdo<T>(
        ieeeAddress: string,
        networkAddress: number,
        clusterId: Zdo.ClusterId,
        payload: Buffer,
        disableResponse: boolean,
    ): Promise<T | void> {
        const transactionID = this.nextTransactionID();
        payload[0] = transactionID;
        const req: ApsDataRequest = {
            requestId: transactionID,
            destAddrMode: PARAM.PARAM.addressMode.NWK_ADDR,
            destAddr16: networkAddress,
            destEndpoint: 0,
            profileId: 0,
            clusterId,
            srcEndpoint: 0,
            asduLength: payload.length,
            asduPayload: Array.from(payload),
            txOptions: 0,
            radius: PARAM.PARAM.txRadius.DEFAULT_RADIUS,
            timeout: 30,
        };

        this.driver
            .enqueueSendDataRequest(req)
            .then(() => {})
            .catch(() => {});

        if (!disableResponse) {
            const responseClusterId = Zdo.Utils.getResponseClusterId(clusterId);

            if (responseClusterId) {
                try {
                    // TODO: response from Zdo.Buffalo
                    const response = await this.waitForData(networkAddress, Zdo.ZDO_PROFILE_ID, responseClusterId);
                } catch (error) {
                    // TODO
                }
            }
        }
    }

    public async supportsBackup(): Promise<boolean> {
        return false;
    }

    public async backup(): Promise<Models.Backup> {
        throw new Error('This adapter does not support backup');
    }

    public async getNetworkParameters(): Promise<NetworkParameters> {
        try {
            const panid = await this.driver.readParameterRequest(PARAM.PARAM.Network.PAN_ID);
            const expanid = await this.driver.readParameterRequest(PARAM.PARAM.Network.APS_EXT_PAN_ID);
            const channel = await this.driver.readParameterRequest(PARAM.PARAM.Network.CHANNEL);
            return {
                panID: panid as number,
                extendedPanID: expanid as number,
                channel: channel as number,
            };
        } catch (error) {
            const msg = 'get network parameters Error:' + error;
            logger.debug(msg, NS);
            return Promise.reject(new Error(msg));
        }
    }

    public async restoreChannelInterPAN(): Promise<void> {
        throw new Error('not supported');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async sendZclFrameInterPANToIeeeAddr(zclFrame: Zcl.Frame, ieeeAddr: string): Promise<void> {
        throw new Error('not supported');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async sendZclFrameInterPANBroadcast(zclFrame: Zcl.Frame, timeout: number): Promise<Events.ZclPayload> {
        throw new Error('not supported');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async sendZclFrameInterPANBroadcastWithResponse(zclFrame: Zcl.Frame, timeout: number): Promise<Events.ZclPayload> {
        throw new Error('not supported');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async setChannelInterPAN(channel: number): Promise<void> {
        throw new Error('not supported');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async setTransmitPower(value: number): Promise<void> {
        throw new Error('not supported');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async sendZclFrameInterPANIeeeAddr(zclFrame: Zcl.Frame, ieeeAddr: string): Promise<void> {
        throw new Error('not supported');
    }

    /**
     * Private methods
     */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private waitForData(
        addr: number,
        profileId: number,
        clusterId: number,
        transactionSequenceNumber?: number,
        timeout?: number,
    ): Promise<ReceivedDataResponse> {
        return new Promise((resolve, reject): void => {
            const ts = Date.now();
            // const commandId = PARAM.PARAM.APS.DATA_INDICATION;
            const req: WaitForDataRequest = {addr, profileId, clusterId, transactionSequenceNumber, resolve, reject, ts, timeout};
            this.openRequestsQueue.push(req);
        });
    }

    private checkReceivedGreenPowerIndication(ind: gpDataInd): void {
        const gpdHeader = Buffer.alloc(15); // applicationId === IEEE_ADDRESS ? 20 : 15
        gpdHeader.writeUInt8(0b00000001, 0); // frameControl: FrameType.SPECIFIC + Direction.CLIENT_TO_SERVER + disableDefaultResponse=false
        gpdHeader.writeUInt8(ind.seqNr!, 1);
        gpdHeader.writeUInt8(ind.id!, 2); // commandIdentifier
        gpdHeader.writeUInt16LE(0, 3); // options, only srcID present
        gpdHeader.writeUInt32LE(ind.srcId!, 5);
        // omitted: gpdIEEEAddr (ieeeAddr)
        // omitted: gpdEndpoint (uint8)
        gpdHeader.writeUInt32LE(ind.frameCounter!, 9);
        gpdHeader.writeUInt8(ind.commandId!, 13);
        gpdHeader.writeUInt8(ind.commandFrameSize!, 14);

        const payBuf = Buffer.concat([gpdHeader, ind.commandFrame!]);
        const payload: Events.ZclPayload = {
            header: Zcl.Header.fromBuffer(payBuf),
            data: payBuf,
            clusterID: Zcl.Clusters.greenPower.ID,
            address: ind.srcId! & 0xffff,
            endpoint: ZSpec.GP_ENDPOINT,
            linkquality: 0xff, // bogus
            groupID: ZSpec.GP_GROUP_ID,
            wasBroadcast: true, // Take the codepath that doesn't require `gppNwkAddr` as its not present in the payload
            destinationEndpoint: ZSpec.GP_ENDPOINT,
        };

        this.waitress.resolve(payload);
        this.emit('zclPayload', payload);
    }

    private checkReceivedDataPayload(resp: ReceivedDataResponse | null): void {
        let srcAddr: number | undefined = undefined;
        let header: Zcl.Header | undefined;
        const payBuf = resp != null ? Buffer.from(resp.asduPayload!) : undefined;

        if (resp != null) {
            if (resp.srcAddr16 != null) {
                srcAddr = resp.srcAddr16;
            } else {
                // For some devices srcAddr64 is reported by ConBee 3, even if the frame contains both
                // srcAddr16 and srcAddr64. This happens even if the request was sent to a short address.
                // At least some parts, e.g. the while loop below, only work with srcAddr16 (i.e. the network
                // address) being set. So we try to look up the network address in the list of know devices.
                if (resp.srcAddr64 != null) {
                    logger.debug(`Try to find network address of ${resp.srcAddr64}`, NS);
                    // Note: Device expects addresses with a 0x prefix...
                    srcAddr = Device.byIeeeAddr('0x' + resp.srcAddr64, false)?.networkAddress;
                }

                assert(srcAddr, 'Failed to find srcAddr of message');
                // apperantly some functions furhter up in the protocol stack expect this to be set.
                // so let's make sure they get the network address
                resp.srcAddr16 = srcAddr; // TODO: can't be undefined
            }
            if (resp.profileId != 0x00) {
                header = Zcl.Header.fromBuffer(payBuf!); // valid from check
            }
        }

        let i = this.openRequestsQueue.length;

        while (i--) {
            const req: WaitForDataRequest = this.openRequestsQueue[i];

            if (srcAddr != null && req.addr === srcAddr && req.clusterId === resp?.clusterId && req.profileId === resp?.profileId) {
                if (header !== undefined && req.transactionSequenceNumber != undefined) {
                    if (req.transactionSequenceNumber === header.transactionSequenceNumber) {
                        logger.debug('resolve data request with transSeq Nr.: ' + req.transactionSequenceNumber, NS);
                        this.openRequestsQueue.splice(i, 1);
                        req.resolve?.(resp);
                    }
                } else {
                    logger.debug('resolve data request without a transSeq Nr.', NS);
                    this.openRequestsQueue.splice(i, 1);
                    req.resolve?.(resp);
                }
            }

            const now = Date.now();

            // Default timeout: 60 seconds.
            // Comparison is negated to prevent orphans when invalid timeout is entered (resulting in NaN).
            if (!(now - req.ts! <= (req.timeout ?? 60000))) {
                //logger.debug("Timeout for request in openRequestsQueue addr: " + req.addr.toString(16) + " clusterId: " + req.clusterId.toString(16) + " profileId: " + req.profileId.toString(16), NS);
                //remove from busyQueue
                this.openRequestsQueue.splice(i, 1);
                req.reject?.('waiting for response TIMEOUT');
            }
        }

        // check unattended incomming messages
        if (resp != null && resp.profileId === 0x00 && resp.clusterId === 0x13) {
            // device Annce
            const payload: Events.DeviceJoinedPayload = {
                networkAddress: payBuf!.readUInt16LE(1), // valid from check
                ieeeAddr: this.driver.macAddrArrayToString(resp.asduPayload!.slice(3, 11)),
            };
            if (this.joinPermitted === true) {
                this.emit('deviceJoined', payload);
            } else {
                this.emit('deviceAnnounce', payload);
            }
        }

        if (resp != null && resp.profileId != 0x00) {
            const payload: Events.ZclPayload = {
                clusterID: resp.clusterId!,
                header,
                data: payBuf!, // valid from check
                address: resp.destAddrMode === 0x03 ? `0x${resp.srcAddr64!}` : resp.srcAddr16!,
                endpoint: resp.srcEndpoint!,
                linkquality: resp.lqi!,
                groupID: resp.destAddrMode === 0x01 ? resp.destAddr16! : 0,
                wasBroadcast: resp.destAddrMode === 0x01 || resp.destAddrMode === 0xf,
                destinationEndpoint: resp.destEndpoint!,
            };

            this.waitress.resolve(payload);
            this.emit('zclPayload', payload);
        }
    }

    private nextTransactionID(): number {
        this.transactionID++;

        if (this.transactionID > 255) {
            this.transactionID = 1;
        }

        return this.transactionID;
    }

    private waitressTimeoutFormatter(matcher: WaitressMatcher, timeout: number): string {
        return (
            `Timeout - ${matcher.address} - ${matcher.endpoint}` +
            ` - ${matcher.transactionSequenceNumber} - ${matcher.clusterID}` +
            ` - ${matcher.commandIdentifier} after ${timeout}ms`
        );
    }

    private waitressValidator(payload: Events.ZclPayload, matcher: WaitressMatcher): boolean {
        return Boolean(
            payload.header &&
                (!matcher.address || payload.address === matcher.address) &&
                payload.endpoint === matcher.endpoint &&
                (!matcher.transactionSequenceNumber || payload.header.transactionSequenceNumber === matcher.transactionSequenceNumber) &&
                payload.clusterID === matcher.clusterID &&
                matcher.frameType === payload.header.frameControl.frameType &&
                matcher.commandIdentifier === payload.header.commandIdentifier &&
                matcher.direction === payload.header.frameControl.direction,
        );
    }
}

export default DeconzAdapter;
