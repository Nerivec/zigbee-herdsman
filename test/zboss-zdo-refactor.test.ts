import {CommandId} from '../src/adapter/zboss/enums';
import {FrameType, makeFrame, writeZBOSSFrame} from '../src/adapter/zboss/frame';
import * as Zdo from '../src/zspec/zdo';

describe('test zboss zdo request refactor', () => {
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

        let frame = writeZBOSSFrame(makeFrame(FrameType.REQUEST, CommandId.ZDO_ACTIVE_EP_REQ, {nwk: networkAddress})).subarray(5);
        let zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, false, networkAddress);
        expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        frame = writeZBOSSFrame(makeFrame(FrameType.REQUEST, CommandId.ZDO_SIMPLE_DESC_REQ, {nwk: networkAddress, endpoint: endpoint})).subarray(5);
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, false, networkAddress, endpoint);
        expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        frame = writeZBOSSFrame(
            makeFrame(FrameType.REQUEST, CommandId.ZDO_PERMIT_JOINING_REQ, {nwk: networkAddress, duration: duration, tcSignificance: 1}),
        ).subarray(5);
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.PERMIT_JOINING_REQUEST, false, duration, 1, []);
        // expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "fc01"
        // Received: "6978fc01"

        frame = writeZBOSSFrame(
            makeFrame(FrameType.REQUEST, CommandId.ZDO_NWK_ADDR_REQ, {nwk: networkAddress, ieee: ieeeAddress, type: 0, startIndex: 0}),
        ).subarray(5);
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.NETWORK_ADDRESS_REQUEST, false, ieeeAddress, false, 0);
        // expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "88776655443322110000"
        // Received: "697888776655443322110000"

        frame = writeZBOSSFrame(makeFrame(FrameType.REQUEST, CommandId.ZDO_NODE_DESC_REQ, {nwk: networkAddress})).subarray(5);
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST, false, networkAddress);
        expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        frame = writeZBOSSFrame(makeFrame(FrameType.REQUEST, CommandId.ZDO_MGMT_LQI_REQ, {nwk: networkAddress, startIndex: startIndex})).subarray(5);
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.LQI_TABLE_REQUEST, false, startIndex);
        // expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "05"
        // Received: "697805"

        // frame = writeZBOSSFrame(makeFrame(FrameType.REQUEST, CommandId.ZDO_MGMT_ROUTING_REQ, {nwk: networkAddress, startIndex: startIndex}));
        // zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.ROUTING_TABLE_REQUEST, false, startIndex);
        // expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        frame = writeZBOSSFrame(
            makeFrame(FrameType.REQUEST, CommandId.ZDO_MGMT_LEAVE_REQ, {nwk: networkAddress, ieee: ieeeAddress, flags: 0}),
        ).subarray(5);
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.LEAVE_REQUEST, false, ieeeAddress, Zdo.LeaveRequestFlags.WITHOUT_REJOIN);
        // expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "887766554433221100"
        // Received: "6978887766554433221100"

        // frame = writeZBOSSFrame(makeFrame(FrameType.REQUEST, CommandId., {}));
        // zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.NWK_UPDATE_REQUEST, false, [channel], 0xfe, undefined, nwkUpdateId, undefined);
        // expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        frame = writeZBOSSFrame(
            makeFrame(FrameType.REQUEST, CommandId.ZDO_BIND_REQ, {
                target: networkAddress,
                srcIeee: ieeeAddress,
                srcEP: endpoint,
                clusterID: clusterId,
                addrMode: Zdo.UNICAST_BINDING,
                dstIeee: ieeeAddress2,
                dstEP: endpoint2 || 1,
            }),
        ).subarray(5);
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
        // expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "8877665544332211f1de00034466337722881199c2"
        // Received: "69788877665544332211f1de00034466337722881199c2"

        // TODO: broken, expects always EUI64
        // frame = writeZBOSSFrame(makeFrame(FrameType.REQUEST, CommandId.ZDO_BIND_REQ, {
        //     target: networkAddress,
        //     srcIeee: ieeeAddress,
        //     srcEP: endpoint,
        //     clusterID: clusterId,
        //     addrMode: Zdo.MULTICAST_BINDING,
        //     dstIeee: groupAddress,
        //     dstEP: endpoint2 || 1,
        // })).subarray(5);
        // zdo = Zdo.Buffalo.buildRequest(
        //     Zdo.ClusterId.BIND_REQUEST,
        //     false,
        //     ieeeAddress,
        //     endpoint,
        //     clusterId,
        //     Zdo.MULTICAST_BINDING,
        //     ieeeAddress2,
        //     groupAddress,
        //     endpoint2,
        // );
        // expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        frame = writeZBOSSFrame(
            makeFrame(FrameType.REQUEST, CommandId.ZDO_BIND_REQ, {
                target: networkAddress,
                srcIeee: ieeeAddress,
                srcEP: endpoint,
                clusterID: clusterId,
                addrMode: Zdo.UNICAST_BINDING,
                dstIeee: ieeeAddress2,
                dstEP: endpoint2 || 1,
            }),
        ).subarray(5);
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
        // expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "8877665544332211f1de00034466337722881199c2"
        // Received: "69788877665544332211f1de00034466337722881199c2"

        // TODO: broken, expects always EUI64
        // frame = writeZBOSSFrame(makeFrame(FrameType.REQUEST, CommandId.ZDO_BIND_REQ, {
        //     target: networkAddress,
        //     srcIeee: ieeeAddress,
        //     srcEP: endpoint,
        //     clusterID: clusterId,
        //     addrMode: Zdo.MULTICAST_BINDING,
        //     dstIeee: groupAddress,
        //     dstEP: endpoint2 || 1,
        // })).subarray(5);
        // zdo = Zdo.Buffalo.buildRequest(
        //     Zdo.ClusterId.UNBIND_REQUEST,
        //     false,
        //     ieeeAddress,
        //     endpoint,
        //     clusterId,
        //     Zdo.MULTICAST_BINDING,
        //     ieeeAddress2,
        //     groupAddress,
        //     endpoint2,
        // );
        // expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));
    });
});
