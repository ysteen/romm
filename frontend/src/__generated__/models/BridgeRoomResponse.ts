/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BridgeCartridge } from './BridgeCartridge';
import type { BridgeMember } from './BridgeMember';
export type BridgeRoomResponse = {
    id: string;
    rom_id: number;
    players: number;
    current: number;
    started: boolean;
    native_allowed: boolean;
    core_name: string;
    core_version: string;
    state_size: number;
    content_crc: number;
    has_password: boolean;
    native_calibration?: (string | null);
    max_prediction?: number;
    cartridges?: (Array<BridgeCartridge> | null);
    native_auth?: boolean;
    collect_cartridges?: boolean;
    content_prepared?: boolean;
    members?: Array<BridgeMember>;
    seats?: Array<(number | null)>;
    generation?: number;
    host?: (number | null);
    running?: boolean;
    starting?: boolean;
    can_start?: boolean;
    native_authority?: boolean;
    save_host?: (number | null);
};

