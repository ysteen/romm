/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BridgeNetworkSettings } from './BridgeNetworkSettings';
export type BridgeAdminResponse = {
    username: string;
    public_url: string;
    native_host: string;
    internal_url: string;
    network: BridgeNetworkSettings;
    defaults: BridgeNetworkSettings;
    broker: Record<string, any>;
};

