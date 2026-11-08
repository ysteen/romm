/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type BridgeMember = {
    player: number;
    owner?: string;
    romId?: (number | null);
    clientPlatform?: (string | null);
    nickname: string;
    kind: 'web' | 'native' | 'preparing';
    ready: boolean;
    playing: boolean;
    ping?: (number | null);
    waitingForNewGame?: boolean;
};

