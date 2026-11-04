/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BridgeCartridge } from './BridgeCartridge';
export type BridgeNativeRequest = {
    nickname?: string;
    password?: (string | null);
    rom_id: number;
    cartridge?: (BridgeCartridge | null);
    platform: 'windows-x86_64' | 'windows-x86' | 'windows-arm64';
    battery?: string;
};

