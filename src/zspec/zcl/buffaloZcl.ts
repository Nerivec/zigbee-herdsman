import {Buffalo} from "../../buffalo";
import {logger} from "../../utils/logger";
import {isNumberArray} from "../../utils/utils";
import {BuffaloZclDataType, DataType, StructuredIndicatorType} from "./definition/enums";
import type {BuffaloZclOptions, StructuredSelector, ZclArray} from "./definition/tstype";
import * as Utils from "./utils";

const NS = "zh:zcl:buffalo";

interface KeyValue {
    [s: string | number]: number | string;
}

const SEC_KEY_LENGTH = 16;

const EXTENSION_FIELD_SETS_DATA_TYPE: {[key: number]: DataType[]} = {
    6: [DataType.UINT8],
    8: [DataType.UINT8],
    258: [DataType.UINT8, DataType.UINT8],
    768: [DataType.UINT16, DataType.UINT16, DataType.UINT16, DataType.UINT8, DataType.UINT8, DataType.UINT8, DataType.UINT16, DataType.UINT16],
};

interface Struct {
    elmType: DataType;
    elmVal: unknown;
}

interface ZclTimeOfDay {
    /** [0-23] */
    hours?: number;
    /** [0-59] */
    minutes?: number;
    /** [0-59] */
    seconds?: number;
    /** [0-99] */
    hundredths?: number;
}

interface ZclDate {
    /** [1900-2155], converted to/from [0-255] => value+1900=year */
    year?: number;
    /** [1-12] */
    month?: number;
    /** [1-31] */
    dayOfMonth?: number;
    /** [1-7] */
    dayOfWeek?: number;
}

interface ZoneInfo {
    zoneID: number;
    zoneStatus: number;
}

interface ExtensionFieldSet {
    clstId: number;
    len: number;
    extField: unknown[];
}

interface ThermoTransition {
    transitionTime: number;
    heatSetpoint?: number;
    coolSetpoint?: number;
}

interface Gpd {
    deviceID: number;
    options: number;
    extendedOptions: number;
    securityKey: Buffer;
    keyMic: number;
    outgoingCounter: number;
    applicationInfo: number;
    manufacturerID: number;
    modelID: number;
    numGpdCommands: number;
    gpdCommandIdList: Buffer;
    numServerClusters: number;
    numClientClusters: number;
    gpdServerClusters: Buffer;
    gpdClientClusters: Buffer;
    genericSwitchConfig: number;
    currentContactStatus: number;
}

interface GPDChannelRequest {
    nextChannel: number;
    nextNextChannel: number;
}

export interface GPDChannelConfiguration {
    commandID: number;
    operationalChannel: number;
    basic: boolean;
}

export interface GPDCommissioningReply {
    commandID: number;
    options: number;
    /** expected valid if corresponding `options` bits set */
    panID?: number;
    /** expected valid if corresponding `options` bits set */
    securityKey?: Buffer;
    /** expected valid if corresponding `options` bits set */
    keyMic?: number;
    /** expected valid if corresponding `options` bits set */
    frameCounter?: number;
}

interface GPDCustomReply {
    commandID: number;
    buffer: Buffer;
}

interface GPDAttributeReport {
    manufacturerCode: number;
    clusterID: number;
    attributes: KeyValue;
}

interface TuyaDataPointValue {
    dp: number;
    datatype: number;
    data: Buffer;
}

interface MiboxerZone {
    zoneNum: number;
    groupId: number;
}

export class BuffaloZcl extends Buffalo {
    private writeOctetStr(value: number[]): void {
        // TODO: this does not allow "non-value" 0xFF
        this.writeUInt8(value.length);
        this.writeBuffer(value, value.length);
    }

    private readOctetStr(): Buffer {
        const length = this.readUInt8();
        return length < 0xff ? this.readBuffer(length) : Buffer.from([]); // non-value
    }

    private writeCharStr(value: string | number[]): void {
        // TODO: this does not allow "non-value" 0xFF
        if (typeof value === "string") {
            this.writeUInt8(Buffer.byteLength(value, "utf8"));
            this.writeUtf8String(value);
        } else {
            // XXX: value.length not written?
            this.writeBuffer(value, value.length);
        }
    }

    private readCharStr(): string {
        const length = this.readUInt8();

        return length < 0xff ? this.readUtf8String(length) : "";
    }

    private writeLongOctetStr(value: number[]): void {
        // TODO: this does not allow "non-value" 0xFF
        this.writeUInt16(value.length);
        this.writeBuffer(value, value.length);
    }

    private readLongOctetStr(): Buffer {
        const length = this.readUInt16();
        return length < 0xffff ? this.readBuffer(length) : Buffer.from([]); // non-value
    }

    private writeLongCharStr(value: string): void {
        // TODO: this does not allow "non-value" 0xFF
        this.writeUInt16(Buffer.byteLength(value, "utf8"));
        this.writeUtf8String(value);
    }

    private readLongCharStr(): string {
        const length = this.readUInt16();
        return length < 0xffff ? this.readUtf8String(length) : ""; // non-value
    }

    private writeArray(value: ZclArray): void {
        const elTypeNumeric = typeof value.elementType === "number" ? value.elementType : DataType[value.elementType];
        this.writeUInt8(elTypeNumeric);
        // TODO: this does not allow writing "non-value" 0xFFFF
        this.writeUInt16(value.elements.length);

        for (const element of value.elements) {
            this.write(elTypeNumeric, element, {});
        }
    }

    private readArray(): unknown[] {
        const values: unknown[] = [];

        const elementType = this.readUInt8();
        const numberOfElements = this.readUInt16();

        if (numberOfElements < 0xffff) {
            for (let i = 0; i < numberOfElements; i++) {
                const value = this.read(elementType, {});
                values.push(value);
            }
        }

        return values;
    }

    private writeStruct(value: Struct[]): void {
        // XXX: from ZCL spec: "The zeroth element may not be written to."
        //      how does this translates to writing here?
        // TODO: this does not allow writing "non-value" 0xFFFF
        this.writeUInt16(value.length);

        for (const v of value) {
            this.writeUInt8(v.elmType);
            this.write(v.elmType, v.elmVal, {});
        }
    }

    private readStruct(): Struct[] {
        const values: Struct[] = [];
        const numberOfElements = this.readUInt16();

        if (numberOfElements < 0xffff) {
            for (let i = 0; i < numberOfElements; i++) {
                const elementType = this.readUInt8();
                const value = this.read(elementType, {});
                values.push({elmType: elementType, elmVal: value});
            }
        }

        return values;
    }

    private writeToD(value: ZclTimeOfDay): void {
        this.writeUInt8(value.hours ?? 0xff);
        this.writeUInt8(value.minutes ?? 0xff);
        this.writeUInt8(value.seconds ?? 0xff);
        this.writeUInt8(value.hundredths ?? 0xff);
    }

    private readToD(): ZclTimeOfDay {
        const hours = this.readUInt8();
        const minutes = this.readUInt8();
        const seconds = this.readUInt8();
        const hundredths = this.readUInt8();

        return {
            hours: hours < 0xff ? hours : undefined,
            minutes: minutes < 0xff ? minutes : undefined,
            seconds: seconds < 0xff ? seconds : undefined,
            hundredths: hundredths < 0xff ? hundredths : undefined,
        };
    }

    private writeDate(value: ZclDate): void {
        this.writeUInt8(value.year !== undefined ? value.year - 1900 : 0xff);
        this.writeUInt8(value.month ?? 0xff);
        this.writeUInt8(value.dayOfMonth ?? 0xff);
        this.writeUInt8(value.dayOfWeek ?? 0xff);
    }

    private readDate(): ZclDate {
        const year = this.readUInt8();
        const month = this.readUInt8();
        const dayOfMonth = this.readUInt8();
        const dayOfWeek = this.readUInt8();

        return {
            year: year < 0xff ? year + 1900 : undefined,
            month: month < 0xff ? month : undefined,
            dayOfMonth: dayOfMonth < 0xff ? dayOfMonth : undefined,
            dayOfWeek: dayOfWeek < 0xff ? dayOfWeek : undefined,
        };
    }

    //--- BuffaloZclDataType

    private writeListZoneInfo(values: ZoneInfo[]): void {
        for (const value of values) {
            this.writeUInt8(value.zoneID);
            this.writeUInt16(value.zoneStatus);
        }
    }

    private readListZoneInfo(length: number): ZoneInfo[] {
        const value: ZoneInfo[] = [];
        for (let i = 0; i < length; i++) {
            value.push({
                zoneID: this.readUInt8(),
                zoneStatus: this.readUInt16(),
            });
        }

        return value;
    }

    private writeExtensionFieldSets(values: {clstId: number; len: number; extField: number[]}[]): void {
        for (const value of values) {
            this.writeUInt16(value.clstId);
            this.writeUInt8(value.len);
            let index = 0;

            for (const entry of value.extField) {
                this.write(EXTENSION_FIELD_SETS_DATA_TYPE[value.clstId][index], entry, {});
                index++;
            }
        }
    }

    private readExtensionFieldSets(): ExtensionFieldSet[] {
        const value: ExtensionFieldSet[] = [];

        // XXX: doesn't work if buffer has more unrelated fields after this one
        while (this.isMore()) {
            const clstId = this.readUInt16();
            const len = this.readUInt8();
            const end = this.getPosition() + len;
            let index = 0;
            const extField: unknown[] = [];

            while (this.getPosition() < end) {
                extField.push(this.read(EXTENSION_FIELD_SETS_DATA_TYPE[clstId][index], {}));
                index++;
            }

            value.push({extField, clstId, len});
        }

        return value;
    }

    private writeListThermoTransitions(value: ThermoTransition[]): void {
        for (const entry of value) {
            this.writeUInt16(entry.transitionTime);

            if (entry.heatSetpoint != null) {
                this.writeUInt16(entry.heatSetpoint);
            }

            if (entry.coolSetpoint != null) {
                this.writeUInt16(entry.coolSetpoint);
            }
        }
    }

    private readListThermoTransitions(options: BuffaloZclOptions): ThermoTransition[] {
        if (options.payload == null || options.payload.mode == null || options.payload.numoftrans == null) {
            throw new Error("Cannot read LIST_THERMO_TRANSITIONS without required payload options specified");
        }

        const heat = options.payload.mode & 1;
        const cool = options.payload.mode & 2;
        const result: ThermoTransition[] = [];

        for (let i = 0; i < options.payload.numoftrans; i++) {
            const entry: ThermoTransition = {
                transitionTime: this.readUInt16(),
            };

            if (heat) {
                entry.heatSetpoint = this.readUInt16();
            }

            if (cool) {
                entry.coolSetpoint = this.readUInt16();
            }

            result.push(entry);
        }

        return result;
    }

    private writeGpdFrame(value: GPDCommissioningReply | GPDChannelConfiguration | GPDCustomReply): void {
        if (value.commandID === 0xf0) {
            // Commissioning Reply
            const v = value as GPDCommissioningReply;

            const panIDPresent = Boolean(v.options & 0x1);
            const gpdSecurityKeyPresent = Boolean(v.options & 0x2);
            const gpdKeyEncryption = Boolean((v.options >> 2) & 0x1);
            const securityLevel = (v.options >> 3) & 0x3;
            const hasGPDKeyMIC = gpdKeyEncryption && gpdSecurityKeyPresent;
            const hasFrameCounter = gpdSecurityKeyPresent && gpdKeyEncryption && (securityLevel === 0b10 || securityLevel === 0b11);

            this.writeUInt8(1 + (panIDPresent ? 2 : 0) + (gpdSecurityKeyPresent ? 16 : 0) + (hasGPDKeyMIC ? 4 : 0) + (hasFrameCounter ? 4 : 0)); // Length
            this.writeUInt8(v.options);

            if (panIDPresent) {
                // biome-ignore lint/style/noNonNullAssertion: ignored using `--suppress`
                this.writeUInt16(v.panID!);
            }

            if (gpdSecurityKeyPresent) {
                // biome-ignore lint/style/noNonNullAssertion: ignored using `--suppress`
                this.writeBuffer(v.securityKey!, 16);
            }

            if (hasGPDKeyMIC) {
                // biome-ignore lint/style/noNonNullAssertion: ignored using `--suppress`
                this.writeUInt32(v.keyMic!);
            }

            if (hasFrameCounter) {
                // biome-ignore lint/style/noNonNullAssertion: ignored using `--suppress`
                this.writeUInt32(v.frameCounter!);
            }
        } else if (value.commandID === 0xf3) {
            // Channel configuration
            const v = value as GPDChannelConfiguration;

            this.writeUInt8(1);
            this.writeUInt8((v.operationalChannel & 0xf) | ((v.basic ? 1 : 0) << 4));
        } else if (value.commandID === 0xf4 || value.commandID === 0xf5 || (value.commandID >= 0xf7 && value.commandID <= 0xff)) {
            // Other commands sent to GPD
            const v = value as GPDCustomReply;

            this.writeUInt8(v.buffer.length);
            this.writeBuffer(v.buffer, v.buffer.length);
        }
        // 0xf1: Write Attributes
        // 0xf2: Read Attributes
        // 0xf6: ZCL Tunneling
    }

    private readGpdFrame(options: BuffaloZclOptions): Gpd | GPDChannelRequest | GPDAttributeReport | {raw: Buffer} | Record<string, never> {
        // ensure offset by options.payload.payloadSize (if any) at end of parsing to not cause issues with spec changes (until supported)
        const startPosition = this.position;

        if (options.payload?.commandID === 0xe0) {
            // Commisioning
            const frame = {
                deviceID: this.readUInt8(),
                options: this.readUInt8(),
                extendedOptions: 0,
                securityKey: Buffer.alloc(16),
                keyMic: 0,
                outgoingCounter: 0,
                applicationInfo: 0,
                manufacturerID: 0,
                modelID: 0,
                numGpdCommands: 0,
                gpdCommandIdList: Buffer.alloc(0),
                numServerClusters: 0,
                numClientClusters: 0,
                gpdServerClusters: Buffer.alloc(0),
                gpdClientClusters: Buffer.alloc(0),
                genericSwitchConfig: 0,
                currentContactStatus: 0,
            };

            if (frame.options & 0x80) {
                frame.extendedOptions = this.readUInt8();
            }

            if (frame.extendedOptions & 0x20) {
                frame.securityKey = this.readBuffer(16);
            }

            if (frame.extendedOptions & 0x40) {
                frame.keyMic = this.readUInt32();
            }

            if (frame.extendedOptions & 0x80) {
                frame.outgoingCounter = this.readUInt32();
            }

            if (frame.options & 0x04) {
                frame.applicationInfo = this.readUInt8();
            }

            if (frame.applicationInfo & 0x01) {
                frame.manufacturerID = this.readUInt16();
            }

            if (frame.applicationInfo & 0x02) {
                frame.modelID = this.readUInt16();
            }

            if (frame.applicationInfo & 0x04) {
                frame.numGpdCommands = this.readUInt8();
                frame.gpdCommandIdList = this.readBuffer(frame.numGpdCommands);
            }

            if (frame.applicationInfo & 0x08) {
                const len = this.readUInt8();
                frame.numServerClusters = len & 0xf;
                frame.numClientClusters = (len >> 4) & 0xf;

                frame.gpdServerClusters = this.readBuffer(2 * frame.numServerClusters);
                frame.gpdClientClusters = this.readBuffer(2 * frame.numClientClusters);
            }

            if (frame.applicationInfo & 0x10) {
                const len = this.readUInt8();

                if (len >= 1) {
                    frame.genericSwitchConfig = this.readUInt8();
                }

                if (len >= 2) {
                    frame.currentContactStatus = this.readUInt8();
                }
            }

            if (options.payload.payloadSize) {
                this.position = startPosition + options.payload.payloadSize;
            }

            return frame;
        }

        if (options.payload?.commandID === 0xe3) {
            // Channel Request
            const channelOpts = this.readUInt8();

            /* v8 ignore start */
            if (options.payload?.payloadSize) {
                this.position = startPosition + options.payload.payloadSize;
            }
            /* v8 ignore stop */

            return {
                nextChannel: channelOpts & 0xf,
                nextNextChannel: channelOpts >> 4,
            };
        }

        if (options.payload?.commandID === 0xa1) {
            // Manufacturer-specific Attribute Reporting
            if (options.payload.payloadSize === undefined) {
                throw new Error("Cannot read GPD_FRAME with commandID=0xA1 without payloadSize options specified");
            }

            const start = this.position;
            const frame = {
                manufacturerCode: this.readUInt16(),
                clusterID: this.readUInt16(),
                attributes: {} as KeyValue,
            };

            const cluster = Utils.getCluster(frame.clusterID, frame.manufacturerCode, {});

            while (this.position - start < options.payload.payloadSize) {
                const attributeID = this.readUInt16();
                const type = this.readUInt8();
                /* v8 ignore next */
                let attribute: string | undefined | number = cluster.getAttribute(attributeID)?.name;

                // number type is only used when going into this if
                if (!attribute) {
                    // this is spammy because of the many manufacturer-specific attributes not currently used
                    logger.debug(`Unknown attribute ${attributeID} in cluster ${cluster.name}`, NS);

                    attribute = attributeID;
                }

                frame.attributes[attribute] = this.read(type, options);
            }

            this.position = startPosition + options.payload.payloadSize;

            return frame;
        }

        if (options.payload?.payloadSize && this.isMore()) {
            // might contain `gppNwkAddr`, `gppGpdLink` & `mic` from ZCL cluster, so limit by `payloadSize`
            return {raw: this.readBuffer(options.payload.payloadSize)};
        }

        if (options.payload?.payloadSize) {
            this.position = startPosition + options.payload.payloadSize;
        }

        return {};
    }

    private writeStructuredSelector(value: StructuredSelector): void {
        if (value != null) {
            const indexes = value.indexes || [];
            const indicatorType = value.indicatorType || StructuredIndicatorType.Whole;
            const indicator = indexes.length + indicatorType;

            this.writeUInt8(indicator);

            for (const index of indexes) {
                this.writeUInt16(index);
            }
        }
    }

    private readStructuredSelector(): StructuredSelector {
        /** [0-15] range */
        const indicator = this.readUInt8();

        if (indicator === 0) {
            // no indexes, whole attribute value is to be read
            return {indicatorType: StructuredIndicatorType.Whole};
        }

        if (indicator < StructuredIndicatorType.WriteAdd) {
            const indexes: StructuredSelector["indexes"] = [];

            for (let i = 0; i < indicator; i++) {
                const index = this.readUInt16();
                indexes.push(index);
            }

            return {indexes};
        }

        throw new Error("Read structured selector was outside [0-15] range.");
    }

    private writeListTuyaDataPointValues(dpValues: TuyaDataPointValue[]): void {
        for (const dpValue of dpValues) {
            this.writeUInt8(dpValue.dp);
            this.writeUInt8(dpValue.datatype);
            const dataLen = dpValue.data.length;
            // UInt16BE
            this.writeUInt8((dataLen >> 8) & 0xff);
            this.writeUInt8(dataLen & 0xff);
            this.writeBuffer(dpValue.data, dataLen);
        }
    }

    private readListTuyaDataPointValues(): TuyaDataPointValue[] {
        const value: TuyaDataPointValue[] = [];

        // XXX: doesn't work if buffer has more unrelated fields after this one
        while (this.isMore()) {
            try {
                const dp = this.readUInt8();
                const datatype = this.readUInt8();
                const len_hi = this.readUInt8();
                const len_lo = this.readUInt8();
                const data = this.readBuffer(len_lo + (len_hi << 8));
                value.push({dp, datatype, data});
            } catch {
                break;
            }
        }

        return value;
    }

    private writeListMiboxerZones(values: MiboxerZone[]): void {
        this.writeUInt8(values.length);

        for (const value of values) {
            this.writeUInt16(value.groupId);
            this.writeUInt8(value.zoneNum);
        }
    }

    private readListMiboxerZones(): MiboxerZone[] {
        const value: MiboxerZone[] = [];
        const len = this.readUInt8();

        for (let i = 0; i < len; i++) {
            const groupId = this.readUInt16();
            const zoneNum = this.readUInt8();

            value.push({groupId, zoneNum});
        }

        return value;
    }

    private writeBigEndianUInt24(value: number): void {
        this.buffer.writeUIntBE(value, this.position, 3);
        this.position += 3;
    }

    private readBigEndianUInt24(): number {
        const value = this.buffer.readUIntBE(this.position, 3);
        this.position += 3;
        return value;
    }

    // NOTE: writeMiStruct is not supported.
    private readMiStruct(): Record<number, number | number[]> {
        const length = this.readUInt8();
        const value: Record<number, number | number[]> = {};

        if (length === 0xff) {
            return value;
        }

        for (let i = 0; i < length; i++) {
            const index = this.readUInt8();
            const dataType = this.readUInt8();
            value[index] = this.read(dataType, {});

            const remaining = this.buffer.length - this.position;
            if (remaining <= 1) {
                if (remaining === 1) {
                    // Some Xiaomi structs have a trailing byte, skip it.
                    this.position += 1;
                }
                break;
            }
        }

        return value;
    }
    // biome-ignore lint/suspicious/noExplicitAny: API
    public write(type: DataType | BuffaloZclDataType, value: any, options: BuffaloZclOptions): void {
        switch (type) {
            case DataType.NO_DATA:
            case DataType.UNKNOWN: {
                return; // nothing to write
            }
            case DataType.DATA8:
            case DataType.BOOLEAN:
            case DataType.BITMAP8:
            case DataType.UINT8:
            case DataType.ENUM8: {
                this.writeUInt8(value);
                break;
            }
            case DataType.DATA16:
            case DataType.BITMAP16:
            case DataType.UINT16:
            case DataType.ENUM16:
            case DataType.CLUSTER_ID:
            case DataType.ATTR_ID: {
                this.writeUInt16(value);
                break;
            }
            case DataType.DATA24:
            case DataType.BITMAP24:
            case DataType.UINT24: {
                this.writeUInt24(value);
                break;
            }
            case DataType.DATA32:
            case DataType.BITMAP32:
            case DataType.UINT32:
            case DataType.UTC:
            case DataType.BAC_OID: {
                this.writeUInt32(value);
                break;
            }
            case DataType.DATA40:
            case DataType.BITMAP40:
            case DataType.UINT40: {
                this.writeUInt40(value);
                break;
            }
            case DataType.DATA48:
            case DataType.BITMAP48:
            case DataType.UINT48: {
                this.writeUInt48(value);
                break;
            }
            case DataType.DATA56:
            case DataType.BITMAP56:
            case DataType.UINT56: {
                this.writeUInt56(value);
                break;
            }
            case DataType.DATA64:
            case DataType.BITMAP64:
            case DataType.UINT64: {
                this.writeUInt64(value);
                break;
            }
            case DataType.INT8: {
                this.writeInt8(value);
                break;
            }
            case DataType.INT16: {
                this.writeInt16(value);
                break;
            }
            case DataType.INT24: {
                this.writeInt24(value);
                break;
            }
            case DataType.INT32: {
                this.writeInt32(value);
                break;
            }
            case DataType.INT40: {
                this.writeInt40(value);
                break;
            }
            case DataType.INT48: {
                this.writeInt48(value);
                break;
            }
            case DataType.INT56: {
                this.writeInt56(value);
                break;
            }
            case DataType.INT64: {
                this.writeInt64(value);
                break;
            }
            // case DataType.SEMI_PREC: {
            //     // https://tc39.es/proposal-float16array/
            //     // not currently used
            //     this.writeSemiFloatLE(value);
            //     break;
            // }
            case DataType.SINGLE_PREC: {
                this.writeFloatLE(value);
                break;
            }
            case DataType.DOUBLE_PREC: {
                this.writeDoubleLE(value);
                break;
            }
            case DataType.OCTET_STR: {
                this.writeOctetStr(value);
                break;
            }
            case DataType.CHAR_STR: {
                this.writeCharStr(value);
                break;
            }
            case DataType.LONG_OCTET_STR: {
                this.writeLongOctetStr(value);
                break;
            }
            case DataType.LONG_CHAR_STR: {
                this.writeLongCharStr(value);
                break;
            }
            case DataType.ARRAY:
            case DataType.SET:
            case DataType.BAG: {
                this.writeArray(value);
                break;
            }
            case DataType.STRUCT: {
                this.writeStruct(value);
                break;
            }
            case DataType.TOD: {
                this.writeToD(value);
                break;
            }
            case DataType.DATE: {
                this.writeDate(value);
                break;
            }
            case DataType.IEEE_ADDR: {
                this.writeIeeeAddr(value);
                break;
            }
            case DataType.SEC_KEY: {
                this.writeBuffer(value, SEC_KEY_LENGTH);
                break;
            }
            case BuffaloZclDataType.USE_DATA_TYPE: {
                if (options.dataType == null) {
                    if (Buffer.isBuffer(value) || isNumberArray(value)) {
                        this.writeBuffer(value, value.length);
                        break;
                    }

                    throw new Error("Cannot write USE_DATA_TYPE without dataType option specified");
                }

                this.write(options.dataType, value, options);
                break;
            }
            case BuffaloZclDataType.LIST_UINT8: {
                this.writeListUInt8(value);
                break;
            }
            case BuffaloZclDataType.LIST_UINT16: {
                this.writeListUInt16(value);
                break;
            }
            case BuffaloZclDataType.LIST_UINT24: {
                this.writeListUInt24(value);
                break;
            }
            case BuffaloZclDataType.LIST_UINT32: {
                this.writeListUInt32(value);
                break;
            }
            case BuffaloZclDataType.LIST_ZONEINFO: {
                this.writeListZoneInfo(value);
                break;
            }
            case BuffaloZclDataType.EXTENSION_FIELD_SETS: {
                this.writeExtensionFieldSets(value);
                break;
            }
            case BuffaloZclDataType.LIST_THERMO_TRANSITIONS: {
                this.writeListThermoTransitions(value);
                break;
            }
            case BuffaloZclDataType.BUFFER: {
                // XXX: inconsistent with read that allows partial with options.length, here always "whole"
                this.writeBuffer(value, value.length);
                break;
            }
            case BuffaloZclDataType.GPD_FRAME: {
                this.writeGpdFrame(value);
                break;
            }
            case BuffaloZclDataType.STRUCTURED_SELECTOR: {
                this.writeStructuredSelector(value);
                break;
            }
            case BuffaloZclDataType.LIST_TUYA_DATAPOINT_VALUES: {
                this.writeListTuyaDataPointValues(value);
                break;
            }
            case BuffaloZclDataType.LIST_MIBOXER_ZONES: {
                this.writeListMiboxerZones(value);
                break;
            }
            case BuffaloZclDataType.BIG_ENDIAN_UINT24: {
                this.writeBigEndianUInt24(value);
                break;
            }
            default: {
                // In case the type is undefined, write it as a buffer to easily allow for custom types
                // e.g. for https://github.com/Koenkk/zigbee-herdsman/issues/127
                if (Buffer.isBuffer(value) || isNumberArray(value)) {
                    this.writeBuffer(value, value.length);
                    break;
                }

                throw new Error(`Write for '${type}' not available`);
            }
        }
    }

    // biome-ignore lint/suspicious/noExplicitAny: API
    public read(type: DataType | BuffaloZclDataType, options: BuffaloZclOptions): any {
        switch (type) {
            case DataType.NO_DATA:
            case DataType.UNKNOWN: {
                return; // nothing to write
            }
            case DataType.DATA8:
            case DataType.BOOLEAN:
            case DataType.BITMAP8:
            case DataType.UINT8:
            case DataType.ENUM8: {
                return this.readUInt8();
            }
            case DataType.DATA16:
            case DataType.BITMAP16:
            case DataType.UINT16:
            case DataType.ENUM16:
            case DataType.CLUSTER_ID:
            case DataType.ATTR_ID: {
                return this.readUInt16();
            }
            case DataType.DATA24:
            case DataType.BITMAP24:
            case DataType.UINT24: {
                return this.readUInt24();
            }
            case DataType.DATA32:
            case DataType.BITMAP32:
            case DataType.UINT32:
            case DataType.UTC:
            case DataType.BAC_OID: {
                return this.readUInt32();
            }
            case DataType.DATA40:
            case DataType.BITMAP40:
            case DataType.UINT40: {
                return this.readUInt40();
            }
            case DataType.DATA48:
            case DataType.BITMAP48:
            case DataType.UINT48: {
                return this.readUInt48();
            }
            case DataType.DATA56:
            case DataType.BITMAP56:
            case DataType.UINT56: {
                return this.readUInt56();
            }
            case DataType.DATA64:
            case DataType.BITMAP64:
            case DataType.UINT64: {
                return this.readUInt64();
            }
            case DataType.INT8: {
                return this.readInt8();
            }
            case DataType.INT16: {
                return this.readInt16();
            }
            case DataType.INT24: {
                return this.readInt24();
            }
            case DataType.INT32: {
                return this.readInt32();
            }
            case DataType.INT40: {
                return this.readInt40();
            }
            case DataType.INT48: {
                return this.readInt48();
            }
            case DataType.INT56: {
                return this.readInt56();
            }
            case DataType.INT64: {
                return this.readInt64();
            }
            // case DataType.SEMI_PREC: {
            //     // https://tc39.es/proposal-float16array/
            //     // not currently used
            //     return this.readSemiFloatLE();
            // }
            case DataType.SINGLE_PREC: {
                return this.readFloatLE();
            }
            case DataType.DOUBLE_PREC: {
                return this.readDoubleLE();
            }
            case DataType.OCTET_STR: {
                return this.readOctetStr();
            }
            case DataType.CHAR_STR: {
                return this.readCharStr();
            }
            case DataType.LONG_OCTET_STR: {
                return this.readLongOctetStr();
            }
            case DataType.LONG_CHAR_STR: {
                return this.readLongCharStr();
            }
            case DataType.ARRAY:
            case DataType.SET:
            case DataType.BAG: {
                return this.readArray();
            }
            case DataType.STRUCT: {
                return this.readStruct();
            }
            case DataType.TOD: {
                return this.readToD();
            }
            case DataType.DATE: {
                return this.readDate();
            }
            case DataType.IEEE_ADDR: {
                return this.readIeeeAddr();
            }
            case DataType.SEC_KEY: {
                return this.readBuffer(SEC_KEY_LENGTH);
            }
            case BuffaloZclDataType.USE_DATA_TYPE: {
                if (options.dataType == null) {
                    return this.readBuffer(options.length ?? this.buffer.length);
                }

                return this.read(options.dataType, options);
            }
            case BuffaloZclDataType.LIST_UINT8: {
                if (options.length == null) {
                    throw new Error("Cannot read LIST_UINT8 without length option specified");
                }

                return this.readListUInt8(options.length);
            }
            case BuffaloZclDataType.LIST_UINT16: {
                if (options.length == null) {
                    throw new Error("Cannot read LIST_UINT16 without length option specified");
                }

                return this.readListUInt16(options.length);
            }
            case BuffaloZclDataType.LIST_UINT24: {
                if (options.length == null) {
                    throw new Error("Cannot read LIST_UINT24 without length option specified");
                }

                return this.readListUInt24(options.length);
            }
            case BuffaloZclDataType.LIST_UINT32: {
                if (options.length == null) {
                    throw new Error("Cannot read LIST_UINT32 without length option specified");
                }

                return this.readListUInt32(options.length);
            }
            case BuffaloZclDataType.LIST_ZONEINFO: {
                if (options.length == null) {
                    throw new Error("Cannot read LIST_ZONEINFO without length option specified");
                }

                return this.readListZoneInfo(options.length);
            }
            case BuffaloZclDataType.EXTENSION_FIELD_SETS: {
                return this.readExtensionFieldSets();
            }
            case BuffaloZclDataType.LIST_THERMO_TRANSITIONS: {
                return this.readListThermoTransitions(options);
            }
            case BuffaloZclDataType.BUFFER: {
                // if length option not specified, read the whole buffer
                return this.readBuffer(options.length ?? this.buffer.length);
            }
            case BuffaloZclDataType.GPD_FRAME: {
                return this.readGpdFrame(options);
            }
            case BuffaloZclDataType.STRUCTURED_SELECTOR: {
                return this.readStructuredSelector();
            }
            case BuffaloZclDataType.LIST_TUYA_DATAPOINT_VALUES: {
                return this.readListTuyaDataPointValues();
            }
            case BuffaloZclDataType.LIST_MIBOXER_ZONES: {
                return this.readListMiboxerZones();
            }
            case BuffaloZclDataType.BIG_ENDIAN_UINT24: {
                return this.readBigEndianUInt24();
            }
            case BuffaloZclDataType.MI_STRUCT: {
                return this.readMiStruct();
            }
        }

        throw new Error(`Read for '${type}' not available`);
    }
}
