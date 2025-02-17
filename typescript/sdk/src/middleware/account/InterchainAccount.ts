import { BigNumber, PopulatedTransaction } from 'ethers';

import { InterchainAccountRouter } from '@hyperlane-xyz/core';
import {
  Address,
  addressToBytes32,
  bytes32ToAddress,
} from '@hyperlane-xyz/utils';

import { appFromAddressesMapHelper } from '../../contracts/contracts.js';
import {
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
} from '../../contracts/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { RouterApp } from '../../router/RouterApps.js';
import { ChainName } from '../../types.js';

import {
  InterchainAccountFactories,
  interchainAccountFactories,
} from './contracts.js';
import { AccountConfig, GetCallRemoteSettings } from './types.js';

export class InterchainAccount extends RouterApp<InterchainAccountFactories> {
  constructor(
    contractsMap: HyperlaneContractsMap<InterchainAccountFactories>,
    multiProvider: MultiProvider,
  ) {
    super(contractsMap, multiProvider);
  }

  router(
    contracts: HyperlaneContracts<InterchainAccountFactories>,
  ): InterchainAccountRouter {
    return contracts.interchainAccountRouter;
  }

  static fromAddressesMap(
    addressesMap: HyperlaneAddressesMap<any>,
    multiProvider: MultiProvider,
  ): InterchainAccount {
    const helper = appFromAddressesMapHelper(
      addressesMap,
      interchainAccountFactories,
      multiProvider,
    );
    return new InterchainAccount(helper.contractsMap, helper.multiProvider);
  }

  async deployAccount(
    destinationChain: ChainName,
    config: AccountConfig,
    routerOverride?: Address,
    ismOverride?: Address,
  ): Promise<Address> {
    const originDomain = this.multiProvider.tryGetDomainId(config.origin);
    if (!originDomain) {
      throw new Error(
        `Origin chain (${config.origin}) metadata needed for deploying ICAs ...`,
      );
    }
    const destinationRouter = this.router(this.contractsMap[destinationChain]);
    const originRouterAddress =
      routerOverride ??
      bytes32ToAddress(await destinationRouter.routers(originDomain));
    const destinationIsmAddress =
      ismOverride ??
      bytes32ToAddress(await destinationRouter.isms(originDomain));
    const destinationAccount = await destinationRouter[
      'getLocalInterchainAccount(uint32,address,address,address)'
    ](originDomain, config.owner, originRouterAddress, destinationIsmAddress);
    if (
      (await this.multiProvider
        .getProvider(destinationChain)
        .getCode(destinationAccount)) === '0x'
    ) {
      await this.multiProvider.handleTx(
        destinationChain,
        destinationRouter[
          'getDeployedInterchainAccount(uint32,address,address,address)'
        ](
          originDomain,
          config.owner,
          originRouterAddress,
          destinationIsmAddress,
        ),
      );
      this.logger.debug(`Interchain account deployed at ${destinationAccount}`);
    } else {
      this.logger.debug(
        `Interchain account recovered at ${destinationAccount}`,
      );
    }
    return destinationAccount;
  }

  // meant for ICA governance to return the populatedTx
  async getCallRemote({
    chain,
    destination,
    innerCalls,
    config,
    hookMetadata,
  }: GetCallRemoteSettings): Promise<PopulatedTransaction> {
    const localRouter = this.router(this.contractsMap[chain]);
    const remoteDomain = this.multiProvider.getDomainId(destination);
    const quote = await localRouter['quoteGasPayment(uint32)'](remoteDomain);
    const remoteRouter = addressToBytes32(
      config.routerOverride ?? this.routerAddress(destination),
    );
    const remoteIsm = addressToBytes32(
      config.ismOverride ??
        (await this.router(this.contractsMap[destination]).isms(remoteDomain)),
    );
    const callEncoded = await localRouter.populateTransaction[
      'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes)'
    ](
      remoteDomain,
      remoteRouter,
      remoteIsm,
      innerCalls.map((call) => ({
        to: addressToBytes32(call.to),
        value: call.value ?? BigNumber.from('0'),
        data: call.data,
      })),
      hookMetadata ?? '0x',
      { value: quote },
    );
    return callEncoded;
  }

  async getAccountConfig(
    chain: ChainName,
    account: Address,
  ): Promise<AccountConfig> {
    const accountOwner = await this.router(
      this.contractsMap[chain],
    ).accountOwners(account);
    const originChain = this.multiProvider.getChainName(accountOwner.origin);
    return {
      origin: originChain,
      owner: accountOwner.owner,
      localRouter: this.router(this.contractsMap[chain]).address,
    };
  }

  // general helper for different overloaded callRemote functions
  // can override the gasLimit by StandardHookMetadata.overrideGasLimit for optional hookMetadata here
  async callRemote({
    chain,
    destination,
    innerCalls,
    config,
    hookMetadata,
  }: GetCallRemoteSettings): Promise<void> {
    await this.multiProvider.sendTransaction(
      chain,
      this.getCallRemote({
        chain,
        destination,
        innerCalls,
        config,
        hookMetadata,
      }),
    );
  }
}

export function buildInterchainAccountApp(
  multiProvider: MultiProvider,
  chain: ChainName,
  config: AccountConfig,
): InterchainAccount {
  if (!config.localRouter) {
    throw new Error('localRouter is required for account deployment');
  }
  const addressesMap: HyperlaneAddressesMap<any> = {
    [chain]: { interchainAccountRouter: config.localRouter },
  };
  return InterchainAccount.fromAddressesMap(addressesMap, multiProvider);
}

export async function deployInterchainAccount(
  multiProvider: MultiProvider,
  chain: ChainName,
  config: AccountConfig,
): Promise<Address> {
  const interchainAccountApp: InterchainAccount = buildInterchainAccountApp(
    multiProvider,
    chain,
    config,
  );
  return interchainAccountApp.deployAccount(chain, config);
}
