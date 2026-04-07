import { Hono } from "hono";
import type { Env } from "@/types";

export const health = new Hono<Env>();

health.get("/", (c) =>
  c.json({
    status: "ok",
    now: new Date().toISOString(),
    version: "0.0.1",
    service: "agent-skill-depot",
    environment: c.env.ENVIRONMENT,
  }),
);
