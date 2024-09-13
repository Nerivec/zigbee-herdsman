import assert from 'assert';

import debounce from 'debounce';

import {ZSpec} from '../../..';
import * as Models from '../../../models';
import {Queue, Wait, Waitress} from '../../../utils';
import {logger} from '../../../utils/logger';
import {BroadcastAddress} from '../../../zspec/enums';
import {EUI64} from '../../../zspec/tstypes';
import * as Zcl from '../../../zspec/zcl';
import * as Zdo from '../../../zspec/zdo';
import {NetworkAddressResponse} from '../../../zspec/zdo/definition/tstypes';
import Adapter from '../../adapter';
import * as Events from '../../events';
import {AdapterOptions, Coordinator, CoordinatorVersion, NetworkOptions, NetworkParameters, SerialPortOptions, StartResult} from '../../tstype';
import * as Constants from '../constants';
import {Constants as UnpiConstants} from '../unpi';
import {Znp, ZpiObject} from '../znp';
import {ZpiObjectPayload} from '../znp/tstype';
import {ZnpAdapterManager} from './manager';
import {ZnpVersion} from './tstype';

const NS = 'zh:zstack';
const Subsystem = UnpiConstants.Subsystem;
const Type = UnpiConstants.Type;
const {ZnpCommandStatus, AddressMode} = Constants.COMMON;

const DataConfirmTimeout = 9999; // Not an actual code
const DataConfirmErrorCodeLookup: {[k: number]: string} = {
    [DataConfirmTimeout]: 'Timeout',
    26: 'MAC no resources',
    183: 'APS no ack',
    205: 'No network route',
    225: 'MAC channel access failure',
    233: 'MAC no ack',
    240: 'MAC transaction expired',
};

interface WaitressMatcher {
    address?: number | string;
    endpoint: number;
    transactionSequenceNumber?: number;
    frameType: Zcl.FrameType;
    clusterID: number;
    commandIdentifier: number;
    direction: number;
}

class DataConfirmError extends Error {
    public code: number;
    constructor(code: number) {
        const message = `Data request failed with error: '${DataConfirmErrorCodeLookup[code]}' (${code})`;
        super(message);
        this.code = code;
    }
}

class ZStackAdapter extends Adapter {
    private deviceAnnounceRouteDiscoveryDebouncers: Map<number, () => void>;
    private znp: Znp;
    // @ts-expect-error initialized in `start`
    private adapterManager: ZnpAdapterManager;
    private transactionID: number;
    // @ts-expect-error initialized in `start`
    private version: {
        product: number;
        transportrev: number;
        majorrel: number;
        minorrel: number;
        maintrel: number;
        revision: string;
    };
    private closing: boolean;
    // @ts-expect-error initialized in `start`
    private queue: Queue;
    private supportsLED?: boolean;
    private interpanLock: boolean;
    private interpanEndpointRegistered: boolean;
    private waitress: Waitress<Events.ZclPayload, WaitressMatcher>;

    public constructor(networkOptions: NetworkOptions, serialPortOptions: SerialPortOptions, backupPath: string, adapterOptions: AdapterOptions) {
        super(networkOptions, serialPortOptions, backupPath, adapterOptions);
        this.hasZdoMessageOverhead = false;
        this.znp = new Znp(this.serialPortOptions.path!, this.serialPortOptions.baudRate!, this.serialPortOptions.rtscts!);

        this.transactionID = 0;
        this.deviceAnnounceRouteDiscoveryDebouncers = new Map();
        this.interpanLock = false;
        this.interpanEndpointRegistered = false;
        this.closing = false;
        this.waitress = new Waitress<Events.ZclPayload, WaitressMatcher>(this.waitressValidator, this.waitressTimeoutFormatter);

        this.znp.on('received', this.onZnpRecieved.bind(this));
        this.znp.on('close', this.onZnpClose.bind(this));
    }

    /**
     * Adapter methods
     */
    public async start(): Promise<StartResult> {
        await this.znp.open();

        const attempts = 3;
        for (let i = 0; i < attempts; i++) {
            try {
                await this.znp.request(Subsystem.SYS, 'ping', {capabilities: 1});
                break;
            } catch (e) {
                if (attempts - 1 === i) {
                    throw new Error(`Failed to connect to the adapter (${e})`);
                }
            }
        }

        // Old firmware did not support version, assume it's Z-Stack 1.2 for now.
        try {
            this.version = (await this.znp.requestWithReply(Subsystem.SYS, 'version', {})).payload;
        } catch {
            logger.debug(`Failed to get zStack version, assuming 1.2`, NS);
            this.version = {transportrev: 2, product: 0, majorrel: 2, minorrel: 0, maintrel: 0, revision: ''};
        }

        const concurrent =
            this.adapterOptions && this.adapterOptions.concurrent
                ? this.adapterOptions.concurrent
                : this.version.product === ZnpVersion.zStack3x0
                  ? 16
                  : 2;

        logger.debug(`Adapter concurrent: ${concurrent}`, NS);

        this.queue = new Queue(concurrent);

        logger.debug(`Detected znp version '${ZnpVersion[this.version.product]}' (${JSON.stringify(this.version)})`, NS);
        this.adapterManager = new ZnpAdapterManager(this.znp, {
            backupPath: this.backupPath,
            version: this.version.product,
            greenPowerGroup: this.greenPowerGroup,
            networkOptions: this.networkOptions,
            adapterOptions: this.adapterOptions,
        });

        const startResult = this.adapterManager.start();

        if (this.adapterOptions.disableLED) {
            // Wait a bit for adapter to startup, otherwise led doesn't disable (tested with CC2531)
            await Wait(200);
            await this.setLED('disable');
        }

        if (this.adapterOptions.transmitPower != null) {
            await this.setTransmitPower(this.adapterOptions.transmitPower);
        }

        return startResult;
    }

    public async stop(): Promise<void> {
        this.closing = true;
        await this.znp.close();
    }

    public static async isValidPath(path: string): Promise<boolean> {
        return Znp.isValidPath(path);
    }

    public static async autoDetectPath(): Promise<string | undefined> {
        return Znp.autoDetectPath();
    }

    public async getCoordinator(): Promise<Coordinator> {
        return this.queue.execute<Coordinator>(async () => {
            this.checkInterpanLock();
            const activeEpRsp = this.waitForAreqZdo('activeEpRsp');
            await this.znp.request(Subsystem.ZDO, 'activeEpReq', {dstaddr: 0, nwkaddrofinterest: 0}, activeEpRsp.ID);
            const activeEp = await activeEpRsp.start();

            const deviceInfo = await this.znp.requestWithReply(Subsystem.UTIL, 'getDeviceInfo', {});

            const endpoints = [];
            for (const endpoint of activeEp.payload.activeeplist) {
                const simpleDescRsp = this.waitForAreqZdo('simpleDescRsp', {endpoint});
                await this.znp.request(Subsystem.ZDO, 'simpleDescReq', {dstaddr: 0, nwkaddrofinterest: 0, endpoint}, simpleDescRsp.ID);
                const simpleDesc = await simpleDescRsp.start();

                endpoints.push({
                    ID: simpleDesc.payload.endpoint,
                    profileID: simpleDesc.payload.profileid,
                    deviceID: simpleDesc.payload.deviceid,
                    inputClusters: simpleDesc.payload.inclusterlist,
                    outputClusters: simpleDesc.payload.outclusterlist,
                });
            }

            return {
                networkAddress: 0,
                manufacturerID: 0,
                ieeeAddr: deviceInfo.payload.ieeeaddr,
                endpoints,
            };
        });
    }

    public async permitJoin(seconds: number, networkAddress?: number): Promise<void> {
        await this.queue.execute<void>(async () => {
            this.checkInterpanLock();

            // `authentication`: TC significance always 1 (zb specs)
            const zdoPayload = Zdo.Buffalo.buildRequest(Zdo.ClusterId.PERMIT_JOINING_REQUEST, this.hasZdoMessageOverhead, seconds, 1, []);

            // 0 === coordinator-only, undefined === broadcast
            const destination = networkAddress ?? ZSpec.BroadcastAddress.DEFAULT;

            await this.sendZdo(
                ZSpec.BLANK_EUI64,
                destination,
                Zdo.ClusterId.PERMIT_JOINING_REQUEST,
                zdoPayload,
                destination === ZSpec.BroadcastAddress.DEFAULT,
            );
            await this.setLED(seconds == 0 ? 'off' : 'on');
        });
    }

    public async getCoordinatorVersion(): Promise<CoordinatorVersion> {
        return {type: ZnpVersion[this.version.product], meta: this.version};
    }

    public async reset(type: 'soft' | 'hard'): Promise<void> {
        if (type === 'soft') {
            await this.znp.request(Subsystem.SYS, 'resetReq', {type: Constants.SYS.resetType.SOFT});
        } else {
            await this.znp.request(Subsystem.SYS, 'resetReq', {type: Constants.SYS.resetType.HARD});
        }
    }

    private async setLED(action: 'disable' | 'on' | 'off'): Promise<void> {
        if (this.supportsLED == undefined) {
            // Only zStack3x0 with 20210430 and greater support LED
            const zStack3x0 = this.version.product === ZnpVersion.zStack3x0;
            this.supportsLED = !zStack3x0 || (zStack3x0 && parseInt(this.version.revision) >= 20210430);
        }

        if (!this.supportsLED || (this.adapterOptions.disableLED && action !== 'disable')) {
            return;
        }

        // Firmwares build on and after 20211029 should handle LED themselves
        const firmwareControlsLed = parseInt(this.version.revision) >= 20211029;
        const lookup = {
            disable: firmwareControlsLed ? {ledid: 0xff, mode: 5} : {ledid: 3, mode: 0},
            on: firmwareControlsLed ? null : {ledid: 3, mode: 1},
            off: firmwareControlsLed ? null : {ledid: 3, mode: 0},
        };

        const payload = lookup[action];
        if (payload) {
            this.znp.request(Subsystem.UTIL, 'ledControl', payload, undefined, 500).catch(() => {
                // We cannot 100% correctly determine if an adapter supports LED. E.g. the zStack 1.2 20190608
                // fw supports led on the CC2531 but not on the CC2530. Therefore if a led request fails never thrown
                // an error but instead mark the led as unsupported.
                // https://github.com/Koenkk/zigbee-herdsman/issues/377
                // https://github.com/Koenkk/zigbee2mqtt/issues/7693
                this.supportsLED = false;
            });
        }
    }

    private async requestNetworkAddress(ieeeAddr: string): Promise<number> {
        /**
         * NOTE: There are cases where multiple nwkAddrRsp are recevied with different network addresses,
         * this is currently not handled, the first nwkAddrRsp is taken.
         */
        logger.debug(`Request network address of '${ieeeAddr}'`, NS);

        const clusterId = Zdo.ClusterId.NETWORK_ADDRESS_REQUEST;
        const zdoPayload = Zdo.Buffalo.buildRequest(clusterId, false, ieeeAddr as EUI64, false, 0);
        const response = await this.sendZdo<NetworkAddressResponse>(ieeeAddr, ZSpec.NULL_NODE_ID, clusterId, zdoPayload, false);

        return response.nwkAddress;
    }

    private supportsAssocRemove(): boolean {
        return this.version.product === ZnpVersion.zStack3x0 && parseInt(this.version.revision) >= 20200805;
    }

    private supportsAssocAdd(): boolean {
        return this.version.product === ZnpVersion.zStack3x0 && parseInt(this.version.revision) >= 20201026;
    }

    private async discoverRoute(networkAddress: number, wait = true): Promise<void> {
        logger.debug(`Discovering route to ${networkAddress}`, NS);
        const payload = {dstAddr: networkAddress, options: 0, radius: Constants.AF.DEFAULT_RADIUS};
        await this.znp.request(Subsystem.ZDO, 'extRouteDisc', payload);

        if (wait) {
            await Wait(3000);
        }
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
        return this.queue.execute<Events.ZclPayload | void>(async () => {
            this.checkInterpanLock();
            return this.sendZclFrameToEndpointInternal(
                ieeeAddr,
                networkAddress,
                endpoint,
                sourceEndpoint || 1,
                zclFrame,
                timeout,
                disableResponse,
                disableRecovery,
                0,
                0,
                false,
                false,
                false,
                undefined,
            );
        }, networkAddress);
    }

    private async sendZclFrameToEndpointInternal(
        ieeeAddr: string,
        networkAddress: number,
        endpoint: number,
        sourceEndpoint: number,
        zclFrame: Zcl.Frame,
        timeout: number,
        disableResponse: boolean,
        disableRecovery: boolean,
        responseAttempt: number,
        dataRequestAttempt: number,
        checkedNetworkAddress: boolean,
        discoveredRoute: boolean,
        assocRemove: boolean,
        assocRestore?: {ieeeadr: string; nwkaddr: number; noderelation: number},
    ): Promise<Events.ZclPayload | void> {
        logger.debug(
            `sendZclFrameToEndpointInternal ${ieeeAddr}:${networkAddress}/${endpoint} ` +
                `(${responseAttempt},${dataRequestAttempt},${this.queue.count()})`,
            NS,
        );
        let response = null;
        const command = zclFrame.command;
        if (command.response != undefined && disableResponse === false) {
            response = this.waitForInternal(
                networkAddress,
                endpoint,
                zclFrame.header.frameControl.frameType,
                Zcl.Direction.SERVER_TO_CLIENT,
                zclFrame.header.transactionSequenceNumber,
                zclFrame.cluster.ID,
                command.response,
                timeout,
            );
        } else if (!zclFrame.header.frameControl.disableDefaultResponse) {
            response = this.waitForInternal(
                networkAddress,
                endpoint,
                Zcl.FrameType.GLOBAL,
                Zcl.Direction.SERVER_TO_CLIENT,
                zclFrame.header.transactionSequenceNumber,
                zclFrame.cluster.ID,
                Zcl.Foundation.defaultRsp.ID,
                timeout,
            );
        }

        const dataConfirmResult = await this.dataRequest(
            networkAddress,
            endpoint,
            sourceEndpoint,
            zclFrame.cluster.ID,
            Constants.AF.DEFAULT_RADIUS,
            zclFrame.toBuffer(),
            timeout,
        );

        if (dataConfirmResult !== ZnpCommandStatus.SUCCESS) {
            // In case dataConfirm timesout (= null) or gives an error, try to recover
            logger.debug(`Data confirm error (${ieeeAddr}:${networkAddress},${dataConfirmResult},${dataRequestAttempt})`, NS);
            if (response !== null) response.cancel();

            /**
             * In case we did an assocRemove in the previous attempt and it still fails after this, assume that the
             * coordinator is still the parent of the device (but for some reason the device is not available now).
             * Re-add the device to the assoc table, otherwise we will never be able to reach it anymore.
             */
            if (assocRemove && assocRestore && this.supportsAssocAdd()) {
                logger.debug(`assocAdd(${assocRestore.ieeeadr})`, NS);
                await this.znp.request(Subsystem.UTIL, 'assocAdd', assocRestore);
                assocRestore = undefined;
            }

            const recoverableErrors = [
                ZnpCommandStatus.NWK_NO_ROUTE,
                ZnpCommandStatus.MAC_NO_ACK,
                ZnpCommandStatus.MAC_CHANNEL_ACCESS_FAILURE,
                ZnpCommandStatus.MAC_TRANSACTION_EXPIRED,
                ZnpCommandStatus.BUFFER_FULL,
                ZnpCommandStatus.MAC_NO_RESOURCES,
            ];

            if (dataRequestAttempt >= 4 || !recoverableErrors.includes(dataConfirmResult) || disableRecovery) {
                throw new DataConfirmError(dataConfirmResult);
            }

            if (
                dataConfirmResult === ZnpCommandStatus.MAC_CHANNEL_ACCESS_FAILURE ||
                dataConfirmResult === ZnpCommandStatus.BUFFER_FULL ||
                dataConfirmResult === ZnpCommandStatus.MAC_NO_RESOURCES
            ) {
                /**
                 * MAC_CHANNEL_ACCESS_FAILURE: When many commands at once are executed we can end up in a MAC
                 * channel access failure error. This is because there is too much traffic on the network.
                 * Retry this command once after a cooling down period.
                 * BUFFER_FULL: When many commands are executed at once the buffer can get full, wait
                 * some time and retry.
                 * MAC_NO_RESOURCES: Operation could not be completed because no memory resources are available,
                 * wait some time and retry.
                 */
                await Wait(2000);
                return this.sendZclFrameToEndpointInternal(
                    ieeeAddr,
                    networkAddress,
                    endpoint,
                    sourceEndpoint,
                    zclFrame,
                    timeout,
                    disableResponse,
                    disableRecovery,
                    responseAttempt,
                    dataRequestAttempt + 1,
                    checkedNetworkAddress,
                    discoveredRoute,
                    assocRemove,
                    assocRestore,
                );
            } else {
                let doAssocRemove = false;
                if (
                    !assocRemove &&
                    dataConfirmResult === ZnpCommandStatus.MAC_TRANSACTION_EXPIRED &&
                    dataRequestAttempt >= 1 &&
                    this.supportsAssocRemove()
                ) {
                    const match = await this.znp.requestWithReply(Subsystem.UTIL, 'assocGetWithAddress', {
                        extaddr: ieeeAddr,
                        nwkaddr: networkAddress,
                    });

                    if (match.payload.nwkaddr !== 0xfffe && match.payload.noderelation !== 255) {
                        doAssocRemove = true;
                        assocRestore = {ieeeadr: ieeeAddr, nwkaddr: networkAddress, noderelation: match.payload.noderelation};
                    }

                    assocRemove = true;
                }

                // NWK_NO_ROUTE: no network route => rediscover route
                // MAC_NO_ACK: route may be corrupted
                // MAC_TRANSACTION_EXPIRED: Mac layer is sleeping
                if (doAssocRemove) {
                    /**
                     * Since child aging is disabled on the firmware, when a end device is directly connected
                     * to the coordinator and changes parent and the coordinator does not recevie this update,
                     * it still thinks it's directly connected.
                     * A discoverRoute() is not send out in this case, therefore remove it from the associated device
                     * list and try again.
                     * Note: assocRemove is a custom command, not available by default, only available on recent
                     * z-stack-firmware firmware version. In case it's not supported by the coordinator we will
                     * automatically timeout after 60000ms.
                     */
                    logger.debug(`assocRemove(${ieeeAddr})`, NS);
                    await this.znp.request(Subsystem.UTIL, 'assocRemove', {ieeeadr: ieeeAddr});
                } else if (!discoveredRoute && dataRequestAttempt >= 1) {
                    discoveredRoute = true;
                    await this.discoverRoute(networkAddress);
                } else if (!checkedNetworkAddress && dataRequestAttempt >= 1) {
                    // Figure out once if the network address has been changed.
                    try {
                        checkedNetworkAddress = true;
                        const actualNetworkAddress = await this.requestNetworkAddress(ieeeAddr);
                        if (networkAddress !== actualNetworkAddress) {
                            logger.debug(`Failed because request was done with wrong network address`, NS);
                            discoveredRoute = true;
                            networkAddress = actualNetworkAddress;
                            await this.discoverRoute(actualNetworkAddress);
                        } else {
                            logger.debug('Network address did not change', NS);
                        }
                    } catch {
                        /* empty */
                    }
                } else {
                    logger.debug('Wait 2000ms', NS);
                    await Wait(2000);
                }

                return this.sendZclFrameToEndpointInternal(
                    ieeeAddr,
                    networkAddress,
                    endpoint,
                    sourceEndpoint,
                    zclFrame,
                    timeout,
                    disableResponse,
                    disableRecovery,
                    responseAttempt,
                    dataRequestAttempt + 1,
                    checkedNetworkAddress,
                    discoveredRoute,
                    assocRemove,
                    assocRestore,
                );
            }
        }

        if (response !== null) {
            try {
                const result = await response.start().promise;
                return result;
            } catch (error) {
                logger.debug(`Response timeout (${ieeeAddr}:${networkAddress},${responseAttempt})`, NS);
                if (responseAttempt < 1 && !disableRecovery) {
                    // No response could be because the radio of the end device is turned off:
                    // Sometimes the coordinator does not properly set the PENDING flag.
                    // Try to rewrite the device entry in the association table, this fixes it sometimes.
                    const match = await this.znp.requestWithReply(Subsystem.UTIL, 'assocGetWithAddress', {
                        extaddr: ieeeAddr,
                        nwkaddr: networkAddress,
                    });
                    logger.debug(
                        `Response timeout recovery: Node relation ${match.payload.noderelation} (${ieeeAddr} / ${match.payload.nwkaddr})`,
                        NS,
                    );
                    if (
                        this.supportsAssocAdd() &&
                        this.supportsAssocRemove() &&
                        match.payload.nwkaddr !== 0xfffe &&
                        match.payload.noderelation == 1
                    ) {
                        logger.debug(`Response timeout recovery: Rewrite association table entry (${ieeeAddr})`, NS);
                        await this.znp.request(Subsystem.UTIL, 'assocRemove', {ieeeadr: ieeeAddr});
                        await this.znp.request(Subsystem.UTIL, 'assocAdd', {
                            ieeeadr: ieeeAddr,
                            nwkaddr: networkAddress,
                            noderelation: match.payload.noderelation,
                        });
                    }
                    // No response could be of invalid route, e.g. when message is send to wrong parent of end device.
                    await this.discoverRoute(networkAddress);
                    return this.sendZclFrameToEndpointInternal(
                        ieeeAddr,
                        networkAddress,
                        endpoint,
                        sourceEndpoint,
                        zclFrame,
                        timeout,
                        disableResponse,
                        disableRecovery,
                        responseAttempt + 1,
                        dataRequestAttempt,
                        checkedNetworkAddress,
                        discoveredRoute,
                        assocRemove,
                        assocRestore,
                    );
                } else {
                    throw error;
                }
            }
        }
    }

    public async sendZclFrameToGroup(groupID: number, zclFrame: Zcl.Frame, sourceEndpoint?: number): Promise<void> {
        return this.queue.execute<void>(async () => {
            this.checkInterpanLock();
            await this.dataRequestExtended(
                AddressMode.ADDR_GROUP,
                groupID,
                0xff,
                0,
                sourceEndpoint || 1,
                zclFrame.cluster.ID,
                Constants.AF.DEFAULT_RADIUS,
                zclFrame.toBuffer(),
                3000,
                true,
            );

            /**
             * As a group command is not confirmed and thus immidiately returns
             * (contrary to network address requests) we will give the
             * command some time to 'settle' in the network.
             */
            await Wait(200);
        });
    }

    public async sendZclFrameToAll(endpoint: number, zclFrame: Zcl.Frame, sourceEndpoint: number, destination: BroadcastAddress): Promise<void> {
        return this.queue.execute<void>(async () => {
            this.checkInterpanLock();
            await this.dataRequestExtended(
                AddressMode.ADDR_16BIT,
                destination,
                endpoint,
                0,
                sourceEndpoint,
                zclFrame.cluster.ID,
                Constants.AF.DEFAULT_RADIUS,
                zclFrame.toBuffer(),
                3000,
                false,
                0,
            );

            /**
             * As a broadcast command is not confirmed and thus immidiately returns
             * (contrary to network address requests) we will give the
             * command some time to 'settle' in the network.
             */
            await Wait(200);
        });
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
        return this.queue.execute<T | void>(async () => {
            this.checkInterpanLock();

            // stack-specific requirements
            switch (clusterId) {
                case Zdo.ClusterId.PERMIT_JOINING_REQUEST: {
                    const prefixedPayload = Buffer.alloc(payload.length + 3);
                    prefixedPayload.writeUInt8(ZSpec.BroadcastAddress[networkAddress] ? AddressMode.ADDR_BROADCAST : AddressMode.ADDR_16BIT, 0);
                    // TODO: confirm zstack uses AddressMode.ADDR_16BIT + ZSpec.BroadcastAddress.DEFAULT to signal "coordinator-only" (assumed from previous code)
                    prefixedPayload.writeUInt16LE(networkAddress === 0 ? ZSpec.BroadcastAddress.DEFAULT : networkAddress, 1);
                    prefixedPayload.set(payload, 3);

                    payload = prefixedPayload;
                    break;
                }

                case Zdo.ClusterId.NWK_UPDATE_REQUEST: {
                    // extra zeroes for empty nwkManagerAddr if necessary
                    const zeroes = 9 - payload.length - 1; /* TODO: zstack doesn't have nwkUpdateId? */
                    const prefixedPayload = Buffer.alloc(payload.length + 3 + zeroes);
                    prefixedPayload.writeUInt16LE(networkAddress, 0);
                    prefixedPayload.writeUInt8(ZSpec.BroadcastAddress[networkAddress] ? AddressMode.ADDR_BROADCAST : AddressMode.ADDR_16BIT, 2);
                    prefixedPayload.set(payload, 3);

                    payload = prefixedPayload;
                    break;
                }

                case Zdo.ClusterId.BIND_REQUEST:
                case Zdo.ClusterId.UNBIND_REQUEST: {
                    // extra zeroes for uint16 (in place of ieee when MULTICAST) and endpoint
                    // TODO: blank endpoint at end should be fine since should not be used with MULTICAST bind type?
                    const zeroes = 21 - payload.length;
                    const prefixedPayload = Buffer.alloc(payload.length + 2 + zeroes);
                    prefixedPayload.writeUInt16LE(networkAddress, 0);
                    prefixedPayload.set(payload, 2);

                    payload = prefixedPayload;
                    break;
                }

                case Zdo.ClusterId.NETWORK_ADDRESS_REQUEST: {
                    // no modification necessary
                    break;
                }

                default: {
                    const prefixedPayload = Buffer.alloc(payload.length + 2);
                    prefixedPayload.writeUInt16LE(networkAddress, 0);
                    prefixedPayload.set(payload, 2);

                    payload = prefixedPayload;
                    break;
                }
            }

            await this.znp.requestZdo(clusterId, payload);

            if (!disableResponse) {
                const responseClusterId = Zdo.Utils.getResponseClusterId(clusterId);

                if (responseClusterId) {
                    // TODO
                    const response = this.waitForAreqZdo(responseClusterId, {srcaddr: networkAddress});

                    return response.start() as T;
                }
            }
        }, ieeeAddress);
    }

    public async addInstallCode(ieeeAddress: string, key: Buffer): Promise<void> {
        assert(this.version.product !== ZnpVersion.zStack12, 'Install code is not supported for ZStack 1.2 adapter');
        const payload = {installCodeFormat: key.length === 18 ? 1 : 2, ieeeaddr: ieeeAddress, installCode: key};
        await this.znp.request(Subsystem.APP_CNF, 'bdbAddInstallCode', payload);
    }

    /**
     * Event handlers
     */
    public onZnpClose(): void {
        if (!this.closing) {
            this.emit('disconnected');
        }
    }

    public onZnpRecieved(object: ZpiObject): void {
        if (object.type !== UnpiConstants.Type.AREQ) {
            return;
        }

        if (object.subsystem === Subsystem.ZDO) {
            if (object.command === 'tcDeviceInd') {
                const payload: Events.DeviceJoinedPayload = {
                    networkAddress: object.payload.nwkaddr,
                    ieeeAddr: object.payload.extaddr,
                };

                this.emit('deviceJoined', payload);
            } else if (object.command === 'endDeviceAnnceInd') {
                const payload: Events.DeviceAnnouncePayload = {
                    networkAddress: object.payload.nwkaddr,
                    ieeeAddr: object.payload.ieeeaddr,
                };

                // Only discover routes to end devices, if bit 1 of capabilities === 0 it's an end device.
                const isEndDevice = (object.payload.capabilities & (1 << 1)) === 0;
                if (isEndDevice) {
                    if (!this.deviceAnnounceRouteDiscoveryDebouncers.has(payload.networkAddress)) {
                        // If a device announces multiple times in a very short time, it makes no sense
                        // to rediscover the route every time.
                        const debouncer = debounce(
                            () => {
                                // eslint-disable-next-line @typescript-eslint/no-floating-promises
                                this.queue.execute<void>(async () => {
                                    /* istanbul ignore next */
                                    this.discoverRoute(payload.networkAddress, false).catch(() => {});
                                }, payload.networkAddress);
                            },
                            60 * 1000,
                            {immediate: true},
                        );
                        this.deviceAnnounceRouteDiscoveryDebouncers.set(payload.networkAddress, debouncer);
                    }

                    const debouncer = this.deviceAnnounceRouteDiscoveryDebouncers.get(payload.networkAddress);
                    assert(debouncer);
                    debouncer();
                }

                this.emit('deviceAnnounce', payload);
            } else if (object.command === 'nwkAddrRsp') {
                const payload: Events.NetworkAddressPayload = {
                    networkAddress: object.payload.nwkaddr,
                    ieeeAddr: object.payload.ieeeaddr,
                };

                this.emit('networkAddress', payload);
            } else if (object.command === 'concentratorIndCb') {
                // Some routers may change short addresses and the announcement
                // is missed by the coordinator. This can happen when there are
                // power outages or other interruptions in service. They may
                // not send additional announcements, causing the device to go
                // offline. However, those devices may instead send
                // Concentrator Indicator Callback commands, which contain both
                // the short and the long address allowing us to update our own
                // mappings.
                // https://e2e.ti.com/cfs-file/__key/communityserver-discussions-components-files/158/4403.zstacktask.c
                // https://github.com/Koenkk/zigbee-herdsman/issues/74
                const payload: Events.NetworkAddressPayload = {
                    networkAddress: object.payload.srcaddr,
                    ieeeAddr: object.payload.extaddr,
                };

                this.emit('networkAddress', payload);
            } else {
                /* istanbul ignore else */
                if (object.command === 'leaveInd') {
                    if (object.payload.rejoin) {
                        logger.debug(`Device leave: Got leave indication with rejoin=true, nothing to do`, NS);
                    } else {
                        const payload: Events.DeviceLeavePayload = {
                            networkAddress: object.payload.srcaddr,
                            ieeeAddr: object.payload.extaddr,
                        };

                        this.emit('deviceLeave', payload);
                    }
                }
            }
        } else {
            /* istanbul ignore else */
            if (object.subsystem === Subsystem.AF) {
                /* istanbul ignore else */
                if (object.command === 'incomingMsg' || object.command === 'incomingMsgExt') {
                    const payload: Events.ZclPayload = {
                        clusterID: object.payload.clusterid,
                        data: object.payload.data,
                        header: Zcl.Header.fromBuffer(object.payload.data),
                        address: object.payload.srcaddr,
                        endpoint: object.payload.srcendpoint,
                        linkquality: object.payload.linkquality,
                        groupID: object.payload.groupid,
                        wasBroadcast: object.payload.wasbroadcast === 1,
                        destinationEndpoint: object.payload.dstendpoint,
                    };

                    this.waitress.resolve(payload);
                    this.emit('zclPayload', payload);
                }
            }
        }
    }

    public async getNetworkParameters(): Promise<NetworkParameters> {
        const result = await this.znp.requestWithReply(Subsystem.ZDO, 'extNwkInfo', {});
        return {
            panID: result.payload.panid,
            extendedPanID: result.payload.extendedpanid,
            channel: result.payload.channel,
        };
    }

    public async supportsBackup(): Promise<boolean> {
        return true;
    }

    public async backup(ieeeAddressesInDatabase: string[]): Promise<Models.Backup> {
        return this.adapterManager.backup.createBackup(ieeeAddressesInDatabase);
    }

    public async setChannelInterPAN(channel: number): Promise<void> {
        return this.queue.execute<void>(async () => {
            this.interpanLock = true;
            await this.znp.request(Subsystem.AF, 'interPanCtl', {cmd: 1, data: [channel]});

            if (!this.interpanEndpointRegistered) {
                // Make sure that endpoint 12 is registered to proxy the InterPAN messages.
                await this.znp.request(Subsystem.AF, 'interPanCtl', {cmd: 2, data: [12]});
                this.interpanEndpointRegistered = true;
            }
        });
    }

    public async sendZclFrameInterPANToIeeeAddr(zclFrame: Zcl.Frame, ieeeAddr: string): Promise<void> {
        return this.queue.execute<void>(async () => {
            await this.dataRequestExtended(
                AddressMode.ADDR_64BIT,
                ieeeAddr,
                0xfe,
                0xffff,
                12,
                zclFrame.cluster.ID,
                30,
                zclFrame.toBuffer(),
                10000,
                false,
            );
        });
    }

    public async sendZclFrameInterPANBroadcast(zclFrame: Zcl.Frame, timeout: number): Promise<Events.ZclPayload> {
        return this.queue.execute<Events.ZclPayload>(async () => {
            const command = zclFrame.command;
            if (command.response == undefined) {
                throw new Error(`Command '${command.name}' has no response, cannot wait for response`);
            }

            const response = this.waitForInternal(
                undefined,
                0xfe,
                zclFrame.header.frameControl.frameType,
                Zcl.Direction.SERVER_TO_CLIENT,
                undefined,
                zclFrame.cluster.ID,
                command.response,
                timeout,
            );

            try {
                await this.dataRequestExtended(
                    AddressMode.ADDR_16BIT,
                    0xffff,
                    0xfe,
                    0xffff,
                    12,
                    zclFrame.cluster.ID,
                    30,
                    zclFrame.toBuffer(),
                    10000,
                    false,
                );
            } catch (error) {
                response.cancel();
                throw error;
            }

            return response.start().promise;
        });
    }

    public async restoreChannelInterPAN(): Promise<void> {
        return this.queue.execute<void>(async () => {
            await this.znp.request(Subsystem.AF, 'interPanCtl', {cmd: 0, data: []});
            // Give adapter some time to restore, otherwise stuff crashes
            await Wait(3000);
            this.interpanLock = false;
        });
    }

    public async setTransmitPower(value: number): Promise<void> {
        return this.queue.execute<void>(async () => {
            await this.znp.request(Subsystem.SYS, 'stackTune', {operation: 0, value});
        });
    }

    private waitForAreqZdo(command: string, payload?: ZpiObjectPayload): {start: () => Promise<ZpiObject>; ID: number} {
        const result = this.znp.waitFor(UnpiConstants.Type.AREQ, Subsystem.ZDO, command, payload);
        const start = (): Promise<ZpiObject> => {
            const startResult = result.start();
            return new Promise<ZpiObject>((resolve, reject) => {
                startResult.promise
                    .then((response) => {
                        // Even though according to the Z-Stack docs the status is `0` or `1`, the actual code
                        // shows it sets the `zstack_ZdpStatus` which contains the ZDO status.
                        const code = response.payload.status;
                        if (code !== Zdo.Status.SUCCESS) {
                            reject(new Error(`ZDO error: ${command.replace('Rsp', '')} failed with status '${Zdo.Status[code]}' (${code})`));
                        } else {
                            resolve(response);
                        }
                    })
                    .catch(reject);
            });
        };
        return {start, ID: result.ID};
    }

    private waitForInternal(
        networkAddress: number | undefined,
        endpoint: number,
        frameType: Zcl.FrameType,
        direction: Zcl.Direction,
        transactionSequenceNumber: number | undefined,
        clusterID: number,
        commandIdentifier: number,
        timeout: number,
    ): {start: () => {promise: Promise<Events.ZclPayload>}; cancel: () => void} {
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
        return {start: waiter.start, cancel};
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
        const waiter = this.waitForInternal(
            networkAddress,
            endpoint,
            frameType,
            direction,
            transactionSequenceNumber,
            clusterID,
            commandIdentifier,
            timeout,
        );

        return {cancel: waiter.cancel, promise: waiter.start().promise};
    }

    /**
     * Private methods
     */
    private async dataRequest(
        destinationAddress: number,
        destinationEndpoint: number,
        sourceEndpoint: number,
        clusterID: number,
        radius: number,
        data: Buffer,
        timeout: number,
    ): Promise<number> {
        const transactionID = this.nextTransactionID();
        const response = this.znp.waitFor(Type.AREQ, Subsystem.AF, 'dataConfirm', {transid: transactionID}, timeout);

        await this.znp.request(
            Subsystem.AF,
            'dataRequest',
            {
                dstaddr: destinationAddress,
                destendpoint: destinationEndpoint,
                srcendpoint: sourceEndpoint,
                clusterid: clusterID,
                transid: transactionID,
                options: 0,
                radius: radius,
                len: data.length,
                data: data,
            },
            response.ID,
        );

        let result = null;
        try {
            const dataConfirm = await response.start().promise;
            result = dataConfirm.payload.status;
        } catch {
            result = DataConfirmTimeout;
        }

        return result;
    }

    private async dataRequestExtended(
        addressMode: number,
        destinationAddressOrGroupID: number | string,
        destinationEndpoint: number,
        panID: number,
        sourceEndpoint: number,
        clusterID: number,
        radius: number,
        data: Buffer,
        timeout: number,
        confirmation: boolean,
        attemptsLeft = 5,
    ): Promise<ZpiObject | void> {
        const transactionID = this.nextTransactionID();
        const response = confirmation ? this.znp.waitFor(Type.AREQ, Subsystem.AF, 'dataConfirm', {transid: transactionID}, timeout) : undefined;

        await this.znp.request(
            Subsystem.AF,
            'dataRequestExt',
            {
                dstaddrmode: addressMode,
                dstaddr: this.toAddressString(destinationAddressOrGroupID),
                destendpoint: destinationEndpoint,
                dstpanid: panID,
                srcendpoint: sourceEndpoint,
                clusterid: clusterID,
                transid: transactionID,
                options: 0, // TODO: why was this here? Constants.AF.options.DISCV_ROUTE,
                radius,
                len: data.length,
                data: data,
            },
            response?.ID,
        );

        if (confirmation && response) {
            const dataConfirm = await response.start().promise;
            if (dataConfirm.payload.status !== ZnpCommandStatus.SUCCESS) {
                if (
                    attemptsLeft > 0 &&
                    (dataConfirm.payload.status === ZnpCommandStatus.MAC_CHANNEL_ACCESS_FAILURE ||
                        dataConfirm.payload.status === ZnpCommandStatus.BUFFER_FULL)
                ) {
                    /**
                     * 225: When many commands at once are executed we can end up in a MAC channel access failure
                     * error. This is because there is too much traffic on the network.
                     * Retry this command once after a cooling down period.
                     */
                    await Wait(2000);
                    return this.dataRequestExtended(
                        addressMode,
                        destinationAddressOrGroupID,
                        destinationEndpoint,
                        panID,
                        sourceEndpoint,
                        clusterID,
                        radius,
                        data,
                        timeout,
                        confirmation,
                        attemptsLeft - 1,
                    );
                } else {
                    throw new DataConfirmError(dataConfirm.payload.status);
                }
            }

            return dataConfirm;
        }
    }

    private nextTransactionID(): number {
        this.transactionID++;

        if (this.transactionID > 255) {
            this.transactionID = 1;
        }

        return this.transactionID;
    }

    private toAddressString(address: number | string): string {
        if (typeof address === 'number') {
            let addressString = address.toString(16);

            for (let i = addressString.length; i < 16; i++) {
                addressString = '0' + addressString;
            }

            return `0x${addressString}`;
        } else {
            return address.toString();
        }
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

    private checkInterpanLock(): void {
        if (this.interpanLock) {
            throw new Error(`Cannot execute command, in Inter-PAN mode`);
        }
    }
}

export default ZStackAdapter;
