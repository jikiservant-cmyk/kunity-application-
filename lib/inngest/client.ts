import { Inngest } from "inngest";

// Create a client to send and receive events
// This is the foundation for background jobs, queues, and cron tasks
export const inngest = new Inngest({ id: "sacco-app" });
