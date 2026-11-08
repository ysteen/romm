/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type BridgeControlRequest = {
    action: 'start' | 'assign' | 'kick' | 'disconnect-policy';
    disconnectPolicy?: ('continue' | 'pause' | null);
    player?: (number | null);
    seat?: (number | null);
};

