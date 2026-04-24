import { ethers } from "ethers";
import path from "path";

// Import typechain factories from the contracts package
// These paths resolve relative to the workspace structure
const CONTRACTS_TYPECHAIN_PATH = path.resolve(
  __dirname,
  "../packages/contracts/typechain-types"
);

export interface DeployedContracts {
  processorEndpoint: {
    address: string;
    contract: import("../packages/contracts/typechain-types").MockProcessorEndpoint;
  };
  token: {
    address: string;
    contract: import("../packages/contracts/typechain-types").MockEIP2612Token;
  };
  teeAuthenticator: {
    address: string;
    contract: import("../packages/contracts/typechain-types").MockTeeAuthenticator;
  };
}

export async function deployContracts(
  provider: ethers.JsonRpcProvider,
  deployer: ethers.Wallet,
  options: {
    applicationId?: bigint;
    tokenRecipients?: string[];
    tokenAmount?: bigint;
    teePublicKey?: Uint8Array;
  } = {}
): Promise<DeployedContracts> {
  const {
    MockProcessorEndpoint__factory,
    MockEIP2612Token__factory,
    MockTeeAuthenticator__factory,
  } = await import(CONTRACTS_TYPECHAIN_PATH);

  const {
    applicationId = 1n,
    tokenRecipients = [],
    tokenAmount = ethers.parseUnits("1000", 18),
    teePublicKey = new Uint8Array(133).fill(0x04), // dummy 133-byte uncompressed P-521 key
  } = options;

  const signer = deployer.connect(provider);

  // Deploy MockTeeAuthenticator
  const teeAuthFactory = new MockTeeAuthenticator__factory(signer);
  const teeAuth = await teeAuthFactory.deploy(
    await signer.getAddress(),
    teePublicKey
  );
  await teeAuth.waitForDeployment();

  // Deploy MockProcessorEndpoint
  const endpointFactory = new MockProcessorEndpoint__factory(signer);
  const endpoint = await endpointFactory.deploy();
  await endpoint.waitForDeployment();

  // Deploy MockEIP2612Token
  const tokenFactory = new MockEIP2612Token__factory(signer);
  const token = await tokenFactory.deploy("Mock USDC", "mUSDC");
  await token.waitForDeployment();

  // Setup: deploy application
  const deployAppTx = await endpoint.deployApplication(applicationId);
  await deployAppTx.wait();

  // Setup: allow token
  const allowTokenTx = await endpoint.addAllowedToken(await token.getAddress());
  await allowTokenTx.wait();

  // Setup: mint tokens to recipients
  for (const recipient of tokenRecipients) {
    const mintTx = await token.mint(recipient, tokenAmount);
    await mintTx.wait();
  }

  return {
    processorEndpoint: {
      address: await endpoint.getAddress(),
      contract: endpoint,
    },
    token: {
      address: await token.getAddress(),
      contract: token,
    },
    teeAuthenticator: {
      address: await teeAuth.getAddress(),
      contract: teeAuth,
    },
  };
}
