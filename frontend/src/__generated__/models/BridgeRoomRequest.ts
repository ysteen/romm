/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BridgeCartridge } from './BridgeCartridge';
export type BridgeRoomRequest = {
    nickname?: string;
    password?: (string | null);
    rom_id: number;
    system: 'gb' | 'gba' | 'snes';
    coreName: 'SameBoy' | 'mGBA Splitscreen' | 'Snes9x';
    coreVersion: string;
    contentCrc: number;
    stateSize: number;
    players: number;
    nativeAllowed?: boolean;
    nativeCalibration?: (string | null);
    maxPrediction?: number;
    cartridges?: (Array<BridgeCartridge> | null);
    collectCartridges?: boolean;
};

