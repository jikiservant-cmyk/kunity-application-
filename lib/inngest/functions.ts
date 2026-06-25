import { inngest } from "./client";

export const calculateDailyPenalties = inngest.createFunction(
  { id: "calculate-daily-penalties", triggers: [{ event: "app/calculate.penalties" }] },
  async ({ event, step }: any) => {
    await step.run("calculate-penalties", async () => {
      console.log("Running Daily Penalty Calculation");
    });
    return { status: "success" };
  }
);
