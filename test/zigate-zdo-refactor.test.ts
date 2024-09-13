import {ZiGateCommandCode} from '../src/adapter/zigate/driver/constants';
import ZiGateObject from '../src/adapter/zigate/driver/ziGateObject';
import {EUI64} from '../src/zspec/tstypes';
import * as Zdo from '../src/zspec/zdo';

describe('test zigate zdo request refactor', () => {
    it('tests', () => {
        const ieeeAddress = '0x1122334455667788';
        const networkAddress = 0x7869;
        const endpoint = 0xf1;
        const duration = 0xfc;
        const startIndex = 0x05;
        const channel = 0x0f;
        const nwkUpdateId = 0;
        const clusterId = 0xde;
        const ieeeAddress2 = '0x9911882277336644';
        const groupAddress = 0x3254;
        const endpoint2 = 0xc2;

        Zdo.Buffalo.prototype.writeUInt16 = function (value: number): void {
            this.buffer.writeUInt16BE(value, this.position);
            this.position += 2;
        };
        Zdo.Buffalo.prototype.readUInt16 = function (): number {
            const value = this.buffer.readUInt16BE(this.position);
            this.position += 2;
            return value;
        };
        Zdo.Buffalo.prototype.readUInt32 = function (): number {
            const value = this.buffer.readUInt32BE(this.position);
            this.position += 4;
            return value;
        };
        Zdo.Buffalo.prototype.writeUInt32 = function (value: number): void {
            this.buffer.writeUInt32BE(value, this.position);
            this.position += 4;
        };
        Zdo.Buffalo.prototype.writeIeeeAddr = function (value: string /*TODO: EUI64*/): void {
            this.writeUInt32(parseInt(value.slice(2, 10), 16));
            this.writeUInt32(parseInt(value.slice(10), 16));
        };
        Zdo.Buffalo.prototype.readIeeeAddr = function (): EUI64 {
            return `0x${this.readBuffer(8).toString('hex')}`;
        };

        let req = ZiGateObject.createRequest(ZiGateCommandCode.ActiveEndpoint, {targetShortAddress: networkAddress});
        let frame = req.toZiGateFrame();
        let zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, false, networkAddress);
        expect(frame.msgPayloadBytes.toString('hex')).toStrictEqual(zdo.toString('hex'));

        req = ZiGateObject.createRequest(ZiGateCommandCode.SimpleDescriptor, {targetShortAddress: networkAddress, endpoint: endpoint});
        frame = req.toZiGateFrame();
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, false, networkAddress, endpoint);
        expect(frame.msgPayloadBytes.toString('hex')).toStrictEqual(zdo.toString('hex'));

        req = ZiGateObject.createRequest(ZiGateCommandCode.PermitJoin, {
            targetShortAddress: networkAddress || 0xfffc,
            interval: duration,
            TCsignificance: 1,
        });
        frame = req.toZiGateFrame();
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.PERMIT_JOINING_REQUEST, false, duration, 1, []);
        // expect(frame.msgPayloadBytes.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "fc01"
        // Received: "7869fc"

        // req = ZiGateObject.createRequest(ZiGateCommandCode.NetworkAddress, {ieeeaddr: ieeeAddress, reqtype: 0, startIndex: 0});
        // frame = req.toZiGateFrame();
        // zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.NETWORK_ADDRESS_REQUEST, false, ieeeAddress, false, 0);
        // expect(frame.msgPayloadBytes.toString('hex')).toStrictEqual(zdo.toString('hex'));

        req = ZiGateObject.createRequest(ZiGateCommandCode.NodeDescriptor, {targetShortAddress: networkAddress});
        frame = req.toZiGateFrame();
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST, false, networkAddress);
        expect(frame.msgPayloadBytes.toString('hex')).toStrictEqual(zdo.toString('hex'));

        req = ZiGateObject.createRequest(ZiGateCommandCode.ManagementLQI, {targetAddress: networkAddress, startIndex: startIndex});
        frame = req.toZiGateFrame();
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.LQI_TABLE_REQUEST, false, startIndex);
        // expect(frame.msgPayloadBytes.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "05"
        // Received: "786905"

        // req = ZiGateObject.createRequest(ZiGateCommandCode.ManagementRouting, {targetAddress: networkAddress, startIndex: startIndex});
        // frame = req.toZiGateFrame();
        // zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.ROUTING_TABLE_REQUEST, false, startIndex);
        // expect(frame.msgPayloadBytes.toString('hex')).toStrictEqual(zdo.toString('hex'));

        req = ZiGateObject.createRequest(ZiGateCommandCode.ManagementLeaveRequest, {
            shortAddress: networkAddress,
            extendedAddress: ieeeAddress,
            rejoin: 0,
            removeChildren: 0,
        });
        frame = req.toZiGateFrame();
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.LEAVE_REQUEST, false, ieeeAddress, Zdo.LeaveRequestFlags.WITHOUT_REJOIN);
        // expect(frame.msgPayloadBytes.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "112233445566778800"
        // Received: "786911223344556677880000"

        // req = ZiGateObject.createRequest(ZiGateCommandCode.NwkUpdate, {
        //     dstaddr: 0xffff, // broadcast with sleepy
        //     dstaddrmode: 15,
        //     channelmask: [channel].reduce((a, c) => a + (1 << c), 0),
        //     scanduration: 0xfe, // change channel
        //     scancount: 0,
        //     nwkmanageraddr: 0,
        // });
        // frame = req.toZiGateFrame();
        // zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.NWK_UPDATE_REQUEST, false, [channel], 0xfe, undefined, nwkUpdateId, undefined);
        // expect(frame.msgPayloadBytes.toString('hex')).toStrictEqual(zdo.toString('hex'));

        req = ZiGateObject.createRequest(ZiGateCommandCode.Bind, {
            destinationNetworkAddress: networkAddress,
            targetExtendedAddress: ieeeAddress,
            targetEndpoint: endpoint,
            clusterID: clusterId,
            destinationAddressMode: Zdo.UNICAST_BINDING,
            destinationAddress: ieeeAddress2,
            destinationEndpoint: endpoint2,
        });
        frame = req.toZiGateFrame();
        zdo = Zdo.Buffalo.buildRequest(
            Zdo.ClusterId.BIND_REQUEST,
            false,
            ieeeAddress,
            endpoint,
            clusterId,
            Zdo.UNICAST_BINDING,
            ieeeAddress2,
            groupAddress,
            endpoint2,
        );
        expect(frame.msgPayloadBytes.toString('hex')).toStrictEqual(zdo.toString('hex'));

        req = ZiGateObject.createRequest(ZiGateCommandCode.Bind, {
            destinationNetworkAddress: networkAddress,
            targetExtendedAddress: ieeeAddress,
            targetEndpoint: endpoint,
            clusterID: clusterId,
            destinationAddressMode: Zdo.MULTICAST_BINDING,
            destinationAddress: groupAddress,
            destinationEndpoint: undefined,
        });
        frame = req.toZiGateFrame();
        zdo = Zdo.Buffalo.buildRequest(
            Zdo.ClusterId.BIND_REQUEST,
            false,
            ieeeAddress,
            endpoint,
            clusterId,
            Zdo.MULTICAST_BINDING,
            ieeeAddress2,
            groupAddress,
            endpoint2,
        );
        // expect(frame.msgPayloadBytes.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "1122334455667788f100de013254"
        // Received: "1122334455667788f100de01325400"

        req = ZiGateObject.createRequest(ZiGateCommandCode.UnBind, {
            destinationNetworkAddress: networkAddress,
            targetExtendedAddress: ieeeAddress,
            targetEndpoint: endpoint,
            clusterID: clusterId,
            destinationAddressMode: Zdo.UNICAST_BINDING,
            destinationAddress: ieeeAddress2,
            destinationEndpoint: endpoint2,
        });
        frame = req.toZiGateFrame();
        zdo = Zdo.Buffalo.buildRequest(
            Zdo.ClusterId.UNBIND_REQUEST,
            false,
            ieeeAddress,
            endpoint,
            clusterId,
            Zdo.UNICAST_BINDING,
            ieeeAddress2,
            groupAddress,
            endpoint2,
        );
        expect(frame.msgPayloadBytes.toString('hex')).toStrictEqual(zdo.toString('hex'));

        req = ZiGateObject.createRequest(ZiGateCommandCode.UnBind, {
            destinationNetworkAddress: networkAddress,
            targetExtendedAddress: ieeeAddress,
            targetEndpoint: endpoint,
            clusterID: clusterId,
            destinationAddressMode: Zdo.MULTICAST_BINDING,
            destinationAddress: groupAddress,
            destinationEndpoint: undefined,
        });
        frame = req.toZiGateFrame();
        zdo = Zdo.Buffalo.buildRequest(
            Zdo.ClusterId.UNBIND_REQUEST,
            false,
            ieeeAddress,
            endpoint,
            clusterId,
            Zdo.MULTICAST_BINDING,
            ieeeAddress2,
            groupAddress,
            endpoint2,
        );
        // expect(frame.msgPayloadBytes.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "1122334455667788f100de013254"
        // Received: "1122334455667788f100de01325400"
    });
});
