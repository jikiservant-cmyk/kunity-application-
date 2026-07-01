import { inngest } from "./client";
import { sendSms } from "../sms";

export const calculateDailyPenalties = inngest.createFunction(
  { id: "calculate-daily-penalties", triggers: [{ event: "app/calculate.penalties" }] },
  async ({ event, step }: any) => {
    await step.run("calculate-penalties", async () => {
      console.log("Running Daily Penalty Calculation");
    });
    return { status: "success" };
  }
);

export const dispatchSms = inngest.createFunction(
  { id: "dispatch-sms", triggers: [{ event: "sms/dispatch" }] } as any,
  async ({ event, step }: any) => {
    const { tenantId, recipientPhone, message, eventType, originUrl, templateData } = event.data;

    // Retry configuration is handled by Inngest automatically
    const result = await step.run("send-sms-via-gateway", async () => {
      return await sendSms({
        tenantId,
        recipientPhone,
        message,
        eventType,
        originUrl,
        templateData
      });
    });

    if (!result.success) {
      throw new Error(`SMS dispatch failed: ${result.error}`);
    }

    return result;
  }
);
