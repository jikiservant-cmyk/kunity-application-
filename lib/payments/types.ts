export type PaymentStatus = "pending" | "completed" | "failed" | "refunded";

export interface PaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  clientSecret?: string;
  providerInfo?: any;
}

export interface PaymentProvider {
  name: string;
  createPaymentIntent(amount: number, currency: string, metadata?: any): Promise<PaymentIntent>;
  confirmPayment?(intentId: string, metadata?: any): Promise<PaymentIntent>;
  verifyWebhook?(payload: any, signature: string): boolean;
}
