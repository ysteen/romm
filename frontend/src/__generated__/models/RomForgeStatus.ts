/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PatchWorkerCapabilities } from './PatchWorkerCapabilities';
import type { RomForgeJobSchema } from './RomForgeJobSchema';
export type RomForgeStatus = {
    worker: PatchWorkerCapabilities;
    active: Array<RomForgeJobSchema>;
    history: Array<RomForgeJobSchema>;
    pending_normalizations: number;
    scan_running: boolean;
    history_limit: number;
    retention_days: number;
};
