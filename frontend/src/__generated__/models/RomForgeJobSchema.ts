/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type RomForgeJobSchema = {
    id: string;
    status: 'queued' | 'running' | 'completed' | 'failed';
    stage: string;
    reused?: boolean;
    download_ready?: boolean;
    output_rom_id?: (number | null);
    output_file_id?: (number | null);
    output_file_name?: (string | null);
    error?: (string | null);
    operation: string;
    file_id: number;
    rom_id: (number | null);
    source_name: (string | null);
    created_at: string;
    started_at: (string | null);
    ended_at: (string | null);
};
