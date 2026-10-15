import { PaymentProvider } from "./types";
import { NajikiProvider } from "./najiki-provider";

// Kunity uses NaJiki only. LivePay is not a supported provider.
// PAYMENT_PROVIDER_TYPE is ignored so a stale env value cannot route money elsewhere.
const createProvider = (): PaymentProvider => new NajikiProvider();

export const paymentGateway = createProvider();
