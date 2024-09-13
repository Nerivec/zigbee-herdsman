import * as Zdo from '../src/zspec/zdo';

describe('test deconz zdo request refactor', () => {
    it('tests', () => {
        const seq = 0x00; // not set until send
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

        const macAddrStringToArray = (addr: string): Array<number> => {
            if (addr.indexOf('0x') === 0) {
                addr = addr.slice(2, addr.length);
            }
            if (addr.length < 16) {
                for (let l = 0; l < 16 - addr.length; l++) {
                    addr = '0' + addr;
                }
            }
            let result: number[] = new Array<number>();
            let y = 0;
            for (let i = 0; i < 8; i++) {
                result[i] = parseInt(addr.substr(y, 2), 16);
                y += 2;
            }
            const reverse = result.reverse();
            return reverse;
        };

        let frame = Buffer.from([seq, networkAddress & 0xff, (networkAddress >> 8) & 0xff]);
        let zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, true, networkAddress);
        expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        frame = Buffer.from([seq, networkAddress & 0xff, (networkAddress >> 8) & 0xff, endpoint]);
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, true, networkAddress, endpoint);
        expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        frame = Buffer.from([seq, duration, 1]);
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.PERMIT_JOINING_REQUEST, true, duration, 1, []);
        expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        // frame = Buffer.from([seq, ]);
        // zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.NETWORK_ADDRESS_REQUEST, true, ieeeAddress, false, 0);
        // expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        frame = Buffer.from([seq, networkAddress & 0xff, (networkAddress >> 8) & 0xff]);
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST, true, networkAddress);
        expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        frame = Buffer.from([seq, startIndex]);
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.LQI_TABLE_REQUEST, true, startIndex);
        expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        frame = Buffer.from([seq, startIndex]);
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.ROUTING_TABLE_REQUEST, true, startIndex);
        expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        frame = Buffer.from([seq, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, Zdo.LeaveRequestFlags.WITHOUT_REJOIN]);
        zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.LEAVE_REQUEST, true, ieeeAddress, Zdo.LeaveRequestFlags.WITHOUT_REJOIN);
        expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        // frame = Buffer.from([seq, ]);
        // zdo = Zdo.Buffalo.buildRequest(Zdo.ClusterId.NWK_UPDATE_REQUEST, true, [channel], 0xfe, undefined, nwkUpdateId, undefined);
        // expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        frame = Buffer.from(
            [seq]
                .concat(macAddrStringToArray(ieeeAddress))
                .concat([endpoint, clusterId & 0xff, (clusterId >> 8) & 0xff, Zdo.UNICAST_BINDING])
                .concat(macAddrStringToArray(ieeeAddress2))
                .concat([endpoint2]),
        );
        zdo = Zdo.Buffalo.buildRequest(
            Zdo.ClusterId.BIND_REQUEST,
            true,
            ieeeAddress,
            endpoint,
            clusterId,
            Zdo.UNICAST_BINDING,
            ieeeAddress2,
            groupAddress,
            endpoint2,
        );
        expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        frame = Buffer.from(
            [seq]
                .concat(macAddrStringToArray(ieeeAddress))
                .concat([endpoint, clusterId & 0xff, (clusterId >> 8) & 0xff, Zdo.MULTICAST_BINDING])
                .concat([groupAddress & 0xff, (groupAddress >> 8) & 0xff]),
        );
        zdo = Zdo.Buffalo.buildRequest(
            Zdo.ClusterId.BIND_REQUEST,
            true,
            ieeeAddress,
            endpoint,
            clusterId,
            Zdo.MULTICAST_BINDING,
            ieeeAddress2,
            groupAddress,
            endpoint2,
        );
        expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        frame = Buffer.from(
            [seq]
                .concat(macAddrStringToArray(ieeeAddress))
                .concat([endpoint, clusterId & 0xff, (clusterId >> 8) & 0xff, Zdo.UNICAST_BINDING])
                .concat(macAddrStringToArray(ieeeAddress2))
                .concat([endpoint2]),
        );
        zdo = Zdo.Buffalo.buildRequest(
            Zdo.ClusterId.UNBIND_REQUEST,
            true,
            ieeeAddress,
            endpoint,
            clusterId,
            Zdo.UNICAST_BINDING,
            ieeeAddress2,
            groupAddress,
            endpoint2,
        );
        expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));

        frame = Buffer.from(
            [seq]
                .concat(macAddrStringToArray(ieeeAddress))
                .concat([endpoint, clusterId & 0xff, (clusterId >> 8) & 0xff, Zdo.MULTICAST_BINDING])
                .concat([groupAddress & 0xff, (groupAddress >> 8) & 0xff]),
        );
        zdo = Zdo.Buffalo.buildRequest(
            Zdo.ClusterId.UNBIND_REQUEST,
            true,
            ieeeAddress,
            endpoint,
            clusterId,
            Zdo.MULTICAST_BINDING,
            ieeeAddress2,
            groupAddress,
            endpoint2,
        );
        expect(frame.toString('hex')).toStrictEqual(zdo.toString('hex'));
    });
});
