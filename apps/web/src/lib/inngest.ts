/**
 * Inngest client singleton. Durable background jobs route through here.
 */
import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "agentskilldepot",
  eventKey: process.env.INNGEST_EVENT_KEY,
});
