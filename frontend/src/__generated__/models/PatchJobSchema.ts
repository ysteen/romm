/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type PatchJobSchema = {
    id: string;
    status: 'queued' | 'running' | 'completed' | 'failed';
    stage: string;
    reused?: boolean;
    download_ready?: boolean;
    output_rom_id?: (number | null);
    output_file_id?: (number | null);
    output_file_name?: (string | null);
    error?: (string | null);
};
