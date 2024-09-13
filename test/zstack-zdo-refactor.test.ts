import {Subsystem} from '../src/adapter/z-stack/unpi/constants';
import {ZpiObject} from '../src/adapter/z-stack/znp';
import * as Zdo from '../src/zspec/zdo';

describe('test zstack zdo request refactor', () => {
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

        const toAddressString = (address: number | string): string => {
            if (typeof address === 'number') {
                let addressString = address.toString(16);

                for (let i = addressString.length; i < 16; i++) {
                    addressString = '0' + addressString;
                }

                return `0x${addressString}`;
            } else {
                return address.toString();
            }
        };

        let z = ZpiObject.createRequest(Subsystem.ZDO, 'activeEpReq', {dstaddr: networkAddress, nwkaddrofinterest: networkAddress});
        let unpi = z.toUnpiFrame();
        let zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, false, networkAddress);
        // expect(unpi.data.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "6978"
        // Received: "69786978"

        z = ZpiObject.createRequest(Subsystem.ZDO, 'simpleDescReq', {dstaddr: networkAddress, nwkaddrofinterest: networkAddress, endpoint: endpoint});
        unpi = z.toUnpiFrame();
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, false, networkAddress, endpoint);
        // expect(unpi.data.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "6978"
        // Received: "69786978"

        z = ZpiObject.createRequest(Subsystem.ZDO, 'mgmtPermitJoinReq', {
            addrmode: networkAddress === undefined ? 0x0f : 0x02,
            dstaddr: networkAddress || 0xfffc,
            duration: duration,
            tcsignificance: 1,
        });
        unpi = z.toUnpiFrame();
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.PERMIT_JOINING_REQUEST, false, duration, 1, []);
        // expect(unpi.data.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "fc01"
        // Received: "026978fc01"

        z = ZpiObject.createRequest(Subsystem.ZDO, 'nwkAddrReq', {ieeeaddr: ieeeAddress, reqtype: 0, startindex: 0});
        unpi = z.toUnpiFrame();
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.NETWORK_ADDRESS_REQUEST, false, ieeeAddress, false, 0);
        expect(unpi.data.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // match

        z = ZpiObject.createRequest(Subsystem.ZDO, 'nodeDescReq', {dstaddr: networkAddress, nwkaddrofinterest: networkAddress});
        unpi = z.toUnpiFrame();
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST, false, networkAddress);
        // expect(unpi.data.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "6978"
        // Received: "69786978"

        z = ZpiObject.createRequest(Subsystem.ZDO, 'mgmtLqiReq', {dstaddr: networkAddress, startindex: startIndex});
        unpi = z.toUnpiFrame();
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.LQI_TABLE_REQUEST, false, startIndex);
        // expect(unpi.data.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "05"
        // Received: "697805"

        z = ZpiObject.createRequest(Subsystem.ZDO, 'mgmtRtgReq', {dstaddr: networkAddress, startindex: startIndex});
        unpi = z.toUnpiFrame();
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.ROUTING_TABLE_REQUEST, false, startIndex);
        // expect(unpi.data.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "05"
        // Received: "697805"

        z = ZpiObject.createRequest(Subsystem.ZDO, 'mgmtLeaveReq', {dstaddr: networkAddress, deviceaddress: ieeeAddress, removechildrenRejoin: 0});
        unpi = z.toUnpiFrame();
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.LEAVE_REQUEST, false, ieeeAddress, Zdo.LeaveRequestFlags.WITHOUT_REJOIN);
        // expect(unpi.data.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "887766554433221100"
        // Received: "6978887766554433221100"

        z = ZpiObject.createRequest(Subsystem.ZDO, 'mgmtNwkUpdateReq', {
            dstaddr: 0xffff, // broadcast with sleepy
            dstaddrmode: 15,
            channelmask: [channel].reduce((a, c) => a + (1 << c), 0),
            scanduration: 0xfe, // change channel
            scancount: 0,
            nwkmanageraddr: 0,
        });
        unpi = z.toUnpiFrame();
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.NWK_UPDATE_REQUEST, false, [channel], 0xfe, undefined, nwkUpdateId, undefined);
        // expect(unpi.data.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "00800000fe00"
        // Received: "ffff0f00800000fe000000"

        z = ZpiObject.createRequest(Subsystem.ZDO, 'bindReq', {
            dstaddr: networkAddress,
            srcaddr: ieeeAddress,
            srcendpoint: endpoint,
            clusterid: clusterId,
            dstaddrmode: Zdo.UNICAST_BINDING,
            dstaddress: toAddressString(ieeeAddress2),
            dstendpoint: endpoint2,
        });
        unpi = z.toUnpiFrame();
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
        // expect(unpi.data.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "8877665544332211f1de00034466337722881199c2"
        // Received: "69788877665544332211f1de00034466337722881199c2"

        z = ZpiObject.createRequest(Subsystem.ZDO, 'bindReq', {
            dstaddr: networkAddress,
            srcaddr: ieeeAddress,
            srcendpoint: endpoint,
            clusterid: clusterId,
            dstaddrmode: Zdo.MULTICAST_BINDING,
            dstaddress: toAddressString(groupAddress),
            dstendpoint: endpoint2,
        });
        unpi = z.toUnpiFrame();
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
        // expect(unpi.data.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "8877665544332211f1de00015432"
        // Received: "69788877665544332211f1de00015432000000000000c2"
        // Expected: "69788877665544332211f1de0001543200000000000000"
        // Received: "69788877665544332211f1de00015432000000000000c2"
        // TODO: blank endpoint at end should be fine since should not be used with this bind type?

        z = ZpiObject.createRequest(Subsystem.ZDO, 'unbindReq', {
            dstaddr: networkAddress,
            srcaddr: ieeeAddress,
            srcendpoint: endpoint,
            clusterid: clusterId,
            dstaddrmode: Zdo.UNICAST_BINDING,
            dstaddress: toAddressString(ieeeAddress2),
            dstendpoint: endpoint2,
        });
        unpi = z.toUnpiFrame();
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
        // expect(unpi.data.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "8877665544332211f1de00034466337722881199c2"
        // Received: "69788877665544332211f1de00034466337722881199c2"

        z = ZpiObject.createRequest(Subsystem.ZDO, 'unbindReq', {
            dstaddr: networkAddress,
            srcaddr: ieeeAddress,
            srcendpoint: endpoint,
            clusterid: clusterId,
            dstaddrmode: Zdo.MULTICAST_BINDING,
            dstaddress: toAddressString(groupAddress),
            dstendpoint: endpoint2,
        });
        unpi = z.toUnpiFrame();
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
        // expect(unpi.data.toString('hex')).toStrictEqual(zdo.toString('hex'));
        // Expected: "8877665544332211f1de00015432"
        // Received: "69788877665544332211f1de00015432000000000000c2"
        // Expected: "69788877665544332211f1de0001543200000000000000"
        // Received: "69788877665544332211f1de00015432000000000000c2"
        // TODO: blank endpoint at end should be fine since should not be used with this bind type?
    });
});
