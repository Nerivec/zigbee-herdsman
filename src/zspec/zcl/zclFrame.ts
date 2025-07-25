import "../../utils/patchBigIntSerialization";

import type {
    ClusterGenericPayload,
    FoundationGenericPayload,
    PayloadOfClusterCommand,
    PayloadOfFoundationByType,
    PayloadOfFoundationCommand,
} from "../../controller/tstype";
import {BuffaloZcl} from "./buffaloZcl";
import {BuffaloZclDataType, DataType, Direction, FrameType, ParameterCondition} from "./definition/enums";
import type {FoundationCommandName} from "./definition/foundation";
import type {Status} from "./definition/status";
import type {BuffaloZclOptions, Cluster, ClusterName, Command, CustomClusters, ParameterDefinition} from "./definition/tstype";
import * as Utils from "./utils";
import {ZclHeader} from "./zclHeader";

const ListTypes: number[] = [
    BuffaloZclDataType.LIST_UINT8,
    BuffaloZclDataType.LIST_UINT16,
    BuffaloZclDataType.LIST_UINT24,
    BuffaloZclDataType.LIST_UINT32,
    BuffaloZclDataType.LIST_ZONEINFO,
];

export class ZclFrame<P extends FoundationGenericPayload | ClusterGenericPayload = FoundationGenericPayload | ClusterGenericPayload> {
    public readonly header: ZclHeader;
    public readonly payload: P;
    public readonly cluster: Cluster;
    public readonly command: Command;

    private constructor(header: ZclHeader, payload: P, cluster: Cluster, command: Command) {
        this.header = header;
        this.payload = payload;
        this.cluster = cluster;
        this.command = command;
    }

    public toString(): string {
        return JSON.stringify({header: this.header, payload: this.payload, command: this.command});
    }

    /**
     * Creating
     */
    public static create<Cl extends number | string, Co extends number | string, Ft extends FrameType>(
        frameType: Ft,
        direction: Direction,
        disableDefaultResponse: boolean,
        manufacturerCode: number | undefined,
        transactionSequenceNumber: number,
        commandKey: Co,
        clusterKey: Cl,
        payload: Ft extends FrameType.GLOBAL ? PayloadOfFoundationCommand<Co> : PayloadOfClusterCommand<Cl, Co>,
        customClusters: CustomClusters,
        reservedBits = 0,
    ): ZclFrame<typeof payload> {
        const cluster = Utils.getCluster(clusterKey, manufacturerCode, customClusters);
        const command: Command =
            frameType === FrameType.GLOBAL
                ? Utils.getGlobalCommand(commandKey)
                : direction === Direction.CLIENT_TO_SERVER
                  ? cluster.getCommand(commandKey)
                  : cluster.getCommandResponse(commandKey);

        const header = new ZclHeader(
            {reservedBits, frameType, direction, disableDefaultResponse, manufacturerSpecific: manufacturerCode != null},
            manufacturerCode,
            transactionSequenceNumber,
            command.ID,
        );

        return new ZclFrame<typeof payload>(header, payload, cluster, command);
    }

    public toBuffer(): Buffer {
        const buffalo = new BuffaloZcl(Buffer.alloc(250));
        this.header.write(buffalo);

        if (this.header.isGlobal) {
            this.writePayloadGlobal(buffalo);
        } else if (this.header.isSpecific) {
            this.writePayloadCluster(buffalo);
        } else {
            throw new Error(`Frametype '${this.header.frameControl.frameType}' not valid`);
        }

        return buffalo.getWritten();
    }

    private writePayloadGlobal(buffalo: BuffaloZcl): void {
        const command = Utils.getFoundationCommand(this.command.ID);

        switch (command.parseStrategy) {
            case "repetitive": {
                for (const entry of this.payload as PayloadOfFoundationByType<typeof command.parseStrategy>) {
                    for (const parameter of command.parameters) {
                        const options: BuffaloZclOptions = {};

                        if (!ZclFrame.conditionsValid(parameter, entry, undefined)) {
                            continue;
                        }

                        if (parameter.type === BuffaloZclDataType.USE_DATA_TYPE && typeof entry.dataType === "number") {
                            // We need to grab the dataType to parse useDataType
                            options.dataType = entry.dataType;
                        }

                        buffalo.write(parameter.type, entry[parameter.name as keyof typeof entry], options);
                    }
                }

                break;
            }

            case "flat": {
                for (const parameter of command.parameters) {
                    const payload = this.payload as PayloadOfFoundationByType<typeof command.parseStrategy>;

                    buffalo.write(parameter.type, payload[parameter.name as keyof typeof payload], {});
                }

                break;
            }

            case "oneof": {
                if (Utils.isFoundationDiscoverRsp(command.ID)) {
                    const payload = this.payload as PayloadOfFoundationByType<typeof command.parseStrategy>;

                    buffalo.writeUInt8(payload.discComplete);

                    for (const entry of payload.attrInfos) {
                        for (const parameter of command.parameters) {
                            buffalo.write(parameter.type, entry[parameter.name as keyof typeof entry], {});
                        }
                    }
                }

                break;
            }
        }
    }

    private writePayloadCluster(buffalo: BuffaloZcl): void {
        const payload = this.payload as ClusterGenericPayload;

        for (const parameter of this.command.parameters) {
            if (!ZclFrame.conditionsValid(parameter, payload, undefined)) {
                continue;
            }

            if (payload[parameter.name] == null) {
                throw new Error(`Parameter '${parameter.name}' is missing`);
            }

            buffalo.write(parameter.type, payload[parameter.name], {});
        }
    }

    /**
     * Parsing
     */
    public static fromBuffer<T extends FoundationGenericPayload | ClusterGenericPayload>(
        clusterID: number,
        header: ZclHeader | undefined,
        buffer: Buffer,
        customClusters: CustomClusters,
    ): ZclFrame<T> {
        if (!header) {
            throw new Error("Invalid ZclHeader.");
        }

        const buffalo = new BuffaloZcl(buffer, header.length);
        const cluster = Utils.getCluster(clusterID, header.manufacturerCode, customClusters);
        const command: Command = header.isGlobal
            ? Utils.getGlobalCommand(header.commandIdentifier)
            : header.frameControl.direction === Direction.CLIENT_TO_SERVER
              ? cluster.getCommand(header.commandIdentifier)
              : cluster.getCommandResponse(header.commandIdentifier);
        const payload = ZclFrame.parsePayload(header, cluster, buffalo);

        return new ZclFrame<T>(header, payload as T, cluster, command);
    }

    private static parsePayload(header: ZclHeader, cluster: Cluster, buffalo: BuffaloZcl): FoundationGenericPayload | ClusterGenericPayload {
        if (header.isGlobal) {
            return ZclFrame.parsePayloadGlobal(header, buffalo);
        }

        if (header.isSpecific) {
            return ZclFrame.parsePayloadCluster(header, cluster, buffalo);
        }

        throw new Error(`Unsupported frameType '${header.frameControl.frameType}'`);
    }

    private static parsePayloadCluster(header: ZclHeader, cluster: Cluster, buffalo: BuffaloZcl): ClusterGenericPayload {
        const command =
            header.frameControl.direction === Direction.CLIENT_TO_SERVER
                ? cluster.getCommand(header.commandIdentifier)
                : cluster.getCommandResponse(header.commandIdentifier);
        const payload: ClusterGenericPayload = {};

        for (const parameter of command.parameters) {
            const options: BuffaloZclOptions = {payload};

            if (!ZclFrame.conditionsValid(parameter, payload, buffalo.getBuffer().length - buffalo.getPosition())) {
                continue;
            }

            if (ListTypes.includes(parameter.type)) {
                const lengthParameter = command.parameters[command.parameters.indexOf(parameter) - 1];
                const length = payload[lengthParameter.name];

                if (typeof length === "number") {
                    options.length = length;
                }
            }

            payload[parameter.name] = buffalo.read(parameter.type, options);
        }

        return payload;
    }

    private static parsePayloadGlobal(header: ZclHeader, buffalo: BuffaloZcl): FoundationGenericPayload {
        const command = Utils.getFoundationCommand(header.commandIdentifier);

        switch (command.parseStrategy) {
            case "repetitive": {
                const payload: PayloadOfFoundationByType<typeof command.parseStrategy> = [];

                while (buffalo.isMore()) {
                    const entry = {} as (typeof payload)[number];

                    for (const parameter of command.parameters) {
                        const options: BuffaloZclOptions = {};

                        if (!ZclFrame.conditionsValid(parameter, entry, buffalo.getBuffer().length - buffalo.getPosition())) {
                            continue;
                        }

                        if (parameter.type === BuffaloZclDataType.USE_DATA_TYPE && typeof entry.dataType === "number") {
                            // We need to grab the dataType to parse useDataType
                            options.dataType = entry.dataType;

                            if (entry.dataType === DataType.CHAR_STR && entry.attrId === 65281) {
                                // [workaround] parse char str as Xiaomi struct
                                options.dataType = BuffaloZclDataType.MI_STRUCT;
                            }
                        }

                        entry[parameter.name as keyof typeof entry] = buffalo.read(parameter.type, options);
                    }

                    payload.push(entry);
                }

                return payload;
            }

            case "flat": {
                const payload = {} as PayloadOfFoundationByType<typeof command.parseStrategy>;

                for (const parameter of command.parameters) {
                    payload[parameter.name as keyof typeof payload] = buffalo.read(parameter.type, {});
                }

                return payload;
            }

            case "oneof": {
                if (Utils.isFoundationDiscoverRsp(command.ID)) {
                    const payload: PayloadOfFoundationByType<typeof command.parseStrategy> = {
                        discComplete: buffalo.readUInt8(),
                        attrInfos: [],
                    };

                    while (buffalo.isMore()) {
                        const entry = {} as (typeof payload.attrInfos)[number];

                        for (const parameter of command.parameters) {
                            entry[parameter.name as keyof typeof entry] = buffalo.read(parameter.type, {});
                        }

                        payload.attrInfos.push(entry);
                    }

                    return payload;
                }
            }
        }

        // XXX: typescript failing to detect no other possibility for `command.parseStrategy`?
        throw new Error(`Unknown Foundation parsing strategy ${command.parseStrategy}`);
    }

    /**
     * Utils
     */

    public static conditionsValid(parameter: ParameterDefinition, entry: ClusterGenericPayload, remainingBufferBytes: number | undefined): boolean {
        if (parameter.conditions) {
            for (const condition of parameter.conditions) {
                switch (condition.type) {
                    case ParameterCondition.STATUS_EQUAL: {
                        if ((entry.status as Status) !== condition.value) {
                            return false;
                        }
                        break;
                    }
                    case ParameterCondition.STATUS_NOT_EQUAL: {
                        if ((entry.status as Status) === condition.value) {
                            return false;
                        }
                        break;
                    }
                    case ParameterCondition.DIRECTION_EQUAL: {
                        if ((entry.direction as Direction) !== condition.value) {
                            return false;
                        }
                        break;
                    }
                    case ParameterCondition.BITMASK_SET: {
                        if (condition.reversed) {
                            if (((entry[condition.param] as number) & condition.mask) === condition.mask) {
                                return false;
                            }
                        } else if (((entry[condition.param] as number) & condition.mask) !== condition.mask) {
                            return false;
                        }
                        break;
                    }
                    case ParameterCondition.BITFIELD_ENUM: {
                        if ((((entry[condition.param] as number) >> condition.offset) & ((1 << condition.size) - 1)) !== condition.value) {
                            return false;
                        }
                        break;
                    }
                    case ParameterCondition.MINIMUM_REMAINING_BUFFER_BYTES: {
                        if (remainingBufferBytes !== undefined && remainingBufferBytes < condition.value) {
                            return false;
                        }
                        break;
                    }
                    case ParameterCondition.DATA_TYPE_CLASS_EQUAL: {
                        if (Utils.getDataTypeClass(entry.dataType as DataType) !== condition.value) {
                            return false;
                        }
                        break;
                    }
                    case ParameterCondition.FIELD_EQUAL: {
                        if (entry[condition.field] !== condition.value) {
                            return false;
                        }
                        break;
                    }
                }
            }
        }

        return true;
    }

    public isCluster(clusterName: FoundationCommandName | ClusterName): boolean {
        return this.cluster.name === clusterName;
    }

    // List of commands is not completed, feel free to add more.
    public isCommand(commandName: FoundationCommandName | "remove" | "add" | "write" | "enrollReq" | "checkin" | "getAlarm" | "arm"): boolean {
        return this.command.name === commandName;
    }
}
