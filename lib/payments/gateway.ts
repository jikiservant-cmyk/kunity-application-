import { PaymentProvider } from "./types";
import { LivePayProvider } from "./live-pay-provider";
import { NajikiProvider } from "./najiki-provider";

// Abstract factory to return the configured payment provider
const createProvider = (): PaymentProvider => {
  const providerType = process.env.PAYMENT_PROVIDER_TYPE || "najiki";
  
  if (providerType === "najiki") {
    return new NajikiProvider();
  }
  
  if (providerType === "livepay") {
    return new LivePayProvider();
  }
  
  throw new Error(`Unsupported payment provider: ${providerType}`);
};

export const paymentGateway = createProvider();
