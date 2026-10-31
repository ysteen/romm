/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
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
};

