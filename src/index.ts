import 'dotenv/config';
import * as KuruSdk from '@kuru-labs/kuru-sdk';
import RouterAbi from '@kuru-labs/kuru-sdk/abi/Router.json';
import { ethers } from 'ethers';
import { Address, createPublicClient, encodeFunctionData, erc20Abi, getContract, Hex, http, parseEther, parseUnits, zeroAddress } from 'viem';
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { privateKeyToAccount } from 'viem/accounts';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';

const API = process.env.KURU_API as string;
const routerAddress = process.env.KURU_ROUTER as Address;
const rpcUrl = process.env.RPC_URL as string;
const bundlerUrl = process.env.BUNDLER_URL as string;
const privateKey = process.env.PRIVATE_KEY as Hex;
const size = 0.0001;

const chain = {
  id: 41454,
  name: 'Monad',
  nativeCurrency: {
    name: 'MON',
    symbol: 'MON',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [rpcUrl],
    }
  },
};

const slippagePercentage = 5;

const publicClient = createPublicClient({
  chain,
  transport: http(rpcUrl),
});
const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

const USDC = '0x9a29e9bab1f0b599d1c6c39b60a79596b3875f56';
const WIF = '0xd9d972d687Bc511D833fe2550C456fEC1a857D2C';

async function main() {
  const poolFetcher = new KuruSdk.PoolFetcher(API);
  const tokenIn: Address = USDC;
  const tokenOut: Address = WIF;
  const outTokenDecimals = 18;

  const pools = await poolFetcher.getAllPools(tokenIn, tokenOut);
  const routeOutput = await KuruSdk.PathFinder.findBestPath(
    provider,
    tokenIn,
    tokenOut,
    size,
    'amountIn',
    undefined,
    pools,
  );

  const clippedOutput = Number((routeOutput.output * (100 - slippagePercentage)) / 100).toFixed(outTokenDecimals);
  const minTokenOutAmount = parseUnits(clippedOutput.toString(), outTokenDecimals);

  const functionName = 'anyToAnySwap';
  const amountInWei = parseUnits(size.toFixed(18), outTokenDecimals);

  /** Create swap transactions as viem */
  const args = [
    routeOutput.route.path.map((pool) => pool.orderbook),
    routeOutput.isBuy,
    routeOutput.nativeSend,
    routeOutput.route.tokenIn,
    routeOutput.route.tokenOut,
    amountInWei,
    minTokenOutAmount,
  ];

  if (routeOutput.output === 0) {
    console.log('No route found');
    process.exit(0);
  }

  const value = routeOutput.nativeSend[0] ? parseEther(size.toFixed(18)) : BigInt(0);
  const data = encodeFunctionData({
    abi: RouterAbi.abi,
    functionName,
    args,
  });

  const entryPoint = getEntryPoint('0.7');
  const kernelVersion = KERNEL_V3_1;

  const signer = privateKeyToAccount(privateKey);
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer,
    entryPoint,
    kernelVersion,
  });

  const sessionKeyAccount = await createKernelAccount(publicClient, {
    plugins: {
      sudo: ecdsaValidator,
    },
    entryPoint,
    kernelVersion,
  });

  const kernelClient = createKernelAccountClient({
    account: sessionKeyAccount,
    chain,
    bundlerTransport: http(bundlerUrl),
    client: publicClient,
  });

  const userAccountAddress = sessionKeyAccount.address;

  console.log('smart wallet address:', userAccountAddress);

  if (zeroAddress !== tokenIn) {
    const currentAllowance = await getAllowance(tokenIn, userAccountAddress, routerAddress);
    if (currentAllowance < amountInWei) {
      const userOpHash1 = await kernelClient.sendUserOperation({
        callData: await kernelClient.account.encodeCalls([
          {
            to: tokenIn,
            value: BigInt(0),
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [routerAddress, amountInWei],
            }),
          },
        ]),
      });

      const tx = await kernelClient.waitForUserOperationReceipt({
        hash: userOpHash1,
      });

      console.log('approval tx: ', tx.receipt.transactionHash);
    }
  }

  const userOpFees = undefined; // await publicClient.getGasPrice();
  const gasIncreaser = 15;

  const userOperation = {
    callData: await kernelClient.account.encodeCalls([
      {
        to: routerAddress,
        value,
        data,
      },
    ]),
    maxPriorityFeePerGas: userOpFees?.maxPriorityFeePerGas
    ? (BigInt(gasIncreaser) * userOpFees.maxPriorityFeePerGas) / BigInt(10)
    : undefined,
    maxFeePerGas: userOpFees?.maxFeePerGas
    ? (BigInt(gasIncreaser) * userOpFees.maxFeePerGas) / BigInt(10)
    : undefined,
  };

  const signedUserOperation = await kernelClient.signUserOperation(userOperation);
  const userOpHash = await kernelClient.sendUserOperation(signedUserOperation);
  const receipt = await kernelClient.waitForUserOperationReceipt({
    hash: userOpHash,
  });
  const txHash = receipt.receipt.transactionHash;
  console.log('op tx hash:', txHash);
  process.exit(0);
}

async function getAllowance(contractAddress: Address, owner: Address, spender: Address) {
  const fromToken = getContract({ abi: erc20Abi, address: contractAddress, client: publicClient });
  const currentAllowanceSwap = await fromToken.read.allowance([owner, spender]);
  return currentAllowanceSwap;
}

void main();
