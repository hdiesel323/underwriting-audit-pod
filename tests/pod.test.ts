import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadPodConfig } from "../src/config.js";
import { DefaultPodHandler } from "../src/handler.js";
import { DynamicSkillEngine } from "../src/skill-engine.js";
import { renderPodUiHtml } from "../src/ui.js";
import { TaskRecord, boundPayload, EpisodeRecord, BeliefRecord } from "../src/types.js";
import { runSleepConsolidation } from "../src/consolidation.js";

describe("Autonomous Worker Pod Chassis Test Suite", () => {
  test("1. loadPodConfig applies defaults and environment overrides", () => {
    const config = loadPodConfig({
      POD_ID: "sample-worker-pod",
      POD_NAME: "Sample Worker Pod",
      POD_ROLE: "worker",
      POD_DOMAIN: "telemetry",
      POD_CAPABILITIES: "data_processing,stream_filtering",
    });

    assert.equal(config.id, "sample-worker-pod");
    assert.equal(config.name, "Sample Worker Pod");
    assert.equal(config.role, "worker");
    assert.equal(config.lob, "telemetry");
    assert.deepEqual(config.capabilities, ["data_processing", "stream_filtering"]);
  });

  test("2. DefaultPodHandler executes task, generates receipts, and records episodes", async () => {
    const handler = new DefaultPodHandler();
    const config = loadPodConfig();
    let publishedTopic = "";
    let recordedEpisode: any = null;

    const task: TaskRecord = {
      id: 1,
      taskId: "task_test_101",
      topic: "data.process",
      source: "unit-test",
      spec: { recordId: "rec_101" },
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const res = await handler.handle(task, {
      podConfig: config,
      now: Date.now(),
      recordEpisode: async (ep) => {
        recordedEpisode = ep;
      },
      publishEvent: async (topic, toPod, payload) => {
        publishedTopic = topic;
      },
    });

    assert.equal(res.taskId, "task_test_101");
    assert.equal(res.role, config.role);
    assert.equal(publishedTopic, "task.completed");
    assert.ok(res.evidence.receiptHash, "Receipt hash must be present");
    assert.equal(typeof res.confidence, "number");
    assert.ok(recordedEpisode, "Episode must be recorded for continuous learning");
    assert.equal(recordedEpisode.taskId, "task_test_101");
  });

  test("3. DynamicSkillEngine respects TTL and handles custom hub URLs", async () => {
    let fetchCount = 0;
    const mockFetcher = async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          skill: {
            id: "seo.robots_txt_probe",
            name: "Robots Probe",
            domain: "seo",
            version: "1.0.0",
            executionType: "rule_engine",
            instructions: "Audit robots",
            specSchema: {},
            description: "Probe",
          },
        }),
        { status: 200 }
      );
    };

    // Instantiate with short TTL of 50ms
    const engine = new DynamicSkillEngine("https://custom-hub.example.com", mockFetcher as any, 50);
    const skill1 = await engine.getSkill("seo.robots_txt_probe");
    assert.equal(fetchCount, 1);
    assert.equal(skill1?.name, "Robots Probe");

    // Second call within TTL should hit cache
    const skillCached = await engine.getSkill("seo.robots_txt_probe");
    assert.equal(fetchCount, 1, "Cache must prevent duplicate network call");

    // Wait for TTL expiration
    await new Promise((resolve) => setTimeout(resolve, 60));
    const skillRefreshed = await engine.getSkill("seo.robots_txt_probe");
    assert.equal(fetchCount, 2, "Expired TTL must re-fetch fresh version from hub");
  });

  test("4. DynamicSkillEngine executes rule_engine probes deterministically", async () => {
    const engine = new DynamicSkillEngine();
    engine.registerLocalSkill({
      id: "seo.robots_txt_probe",
      name: "Robots Probe",
      domain: "seo",
      version: "1.0.0",
      description: "Audits AI crawlers",
      specSchema: {},
      executionType: "rule_engine",
      instructions: "Check bots",
    });

    const skill = await engine.getSkill("seo.robots_txt_probe");
    assert.ok(skill);

    const result = await engine.execute(skill, {
      robotsTxtContent: "User-agent: GPTBot\nDisallow: /\nUser-agent: ClaudeBot\nDisallow:",
    });

    assert.equal(result.botStatus.GPTBot, "blocked");
    assert.equal(result.botStatus.ClaudeBot, "allowed");
    assert.equal(result.score, 75);
    assert.equal(result.confidence, 1.0);
  });

  test("5. boundPayload enforces byte bounds without corrupting small payloads", () => {
    const small = { key: "value", num: 123 };
    const boundedSmall = boundPayload(small, 1024);
    assert.deepEqual(boundedSmall, small);

    // Large payload exceeding 100 bytes
    const large = { text: "x".repeat(500) };
    const boundedLarge = boundPayload(large, 100);
    assert.equal((boundedLarge as any)._truncated, true);
    assert.ok((boundedLarge as any)._originalByteSize > 500);
  });

  test("6. Confidence < 0.8 triggers verification escalation", async () => {
    const handler = new DefaultPodHandler();
    const config = loadPodConfig();
    let publishedTopic = "";

    const task: TaskRecord = {
      id: 2,
      taskId: "task_low_conf_99",
      topic: "unclear.domain",
      source: "unit-test",
      spec: { requireVerification: true },
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await handler.handle(task, {
      podConfig: config,
      now: Date.now(),
      publishEvent: async (topic) => {
        publishedTopic = topic;
      },
    });

    assert.equal(publishedTopic, "task.verification_requested");
  });

  test("7. renderPodUiHtml produces valid cockpit markup", () => {
    const config = loadPodConfig();
    const html = renderPodUiHtml(config, []);

    assert.equal(html.includes("Worker Pod Cockpit"), true);
    assert.equal(html.includes("DOMAIN:"), true);
    assert.equal(html.includes("Task Execution Ledger"), true);
  });

  test("8. DynamicSkillEngine.executeWithAi constructs few-shot prompt with recalled episodes", async () => {
    const engine = new DynamicSkillEngine();
    let capturedPrompt = "";

    const mockAi = async (model: string, input: any) => {
      capturedPrompt = input.messages[1].content;
      return { response: "Generated synthetic article" };
    };

    const promptSkill = {
      id: "content.generator",
      name: "Article Generator",
      domain: "content",
      version: "1.0.0",
      description: "Writes articles",
      specSchema: {},
      executionType: "prompt_template" as const,
      instructions: "Generate 500 words on topic",
    };

    const episodes: EpisodeRecord[] = [
      {
        id: 1,
        taskId: "task_prev_1",
        topic: "content.generator",
        specSummary: "Topic: SEO guide",
        actionTaken: "Generated guide",
        outcome: "Success",
        confidence: 0.98,
        latencyMs: 120,
        createdAt: Date.now() - 1000,
      },
    ];

    const result = await engine.executeWithAi(promptSkill, { keyword: "medicare" }, {
      ai: mockAi,
      recalledEpisodes: episodes,
    });

    assert.ok(capturedPrompt.includes("Example Task: task_prev_1"), "Recalled episode must appear in prompt");
    assert.ok(capturedPrompt.includes("medicare"), "Spec must appear in prompt");
    assert.equal(result.confidence, 0.95);
    assert.equal(result.episodesUsed, 1);
  });

  test("9. DynamicSkillEngine.executeWithAi injects operational beliefs into prompt context", async () => {
    const engine = new DynamicSkillEngine();
    let capturedPrompt = "";

    const mockAi = async (model: string, input: any) => {
      capturedPrompt = input.messages[1].content;
      return { response: "Audit successful" };
    };

    const promptSkill = {
      id: "seo.audit",
      name: "SEO Auditor",
      domain: "seo",
      version: "1.0.0",
      description: "Audits pages",
      specSchema: {},
      executionType: "prompt_template" as const,
      instructions: "Audit the domain",
    };

    const beliefs: BeliefRecord[] = [
      {
        id: "belief_seo_robots",
        domain: "seo",
        claim: "Robots.txt wildcards override specific user-agent blocks",
        confidence: 0.98,
        evidenceCount: 14,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 5000,
      },
    ];

    const result = await engine.executeWithAi(promptSkill, { domain: "example.com" }, {
      ai: mockAi,
      beliefs,
    });

    assert.ok(capturedPrompt.includes("Operational Beliefs & Domain Principles"), "Beliefs header must appear in prompt");
    assert.ok(capturedPrompt.includes("Robots.txt wildcards override"), "Belief claim must be present");
    assert.equal(result.beliefsUsed, 1);
  });

  test("10. runSleepConsolidation decays stale beliefs and synthesizes new principles from clustered episodes", async () => {
    const now = 1793650000000;
    const memoryDb: any[] = [];
    const beliefsDb = new Map<string, any>();

    // Seed mock DB adapter
    const mockDb = {
      prepare(query: string) {
        return {
          bind(...args: any[]) {
            return {
              all: async () => {
                if (query.includes("FROM episodes")) {
                  const windowStart = args[0];
                  return { results: memoryDb.filter((e) => e.created_at >= windowStart) };
                }
                return { results: [] };
              },
              run: async () => {
                if (query.includes("DELETE FROM beliefs")) {
                  const expireThreshold = args[0];
                  let changes = 0;
                  for (const [id, b] of beliefsDb.entries()) {
                    if (b.expires_at && b.expires_at < expireThreshold) {
                      beliefsDb.delete(id);
                      changes++;
                    }
                  }
                  return { meta: { changes } };
                }
                if (query.includes("INSERT INTO beliefs")) {
                  const [id, domain, claim, confidence, evidenceCount, sourceEpisodes, expiresAt] = args;
                  beliefsDb.set(id, { id, domain, claim, confidence, evidenceCount, expiresAt });
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    };

    // 1. Seed an expired belief
    beliefsDb.set("old_stale_belief", {
      id: "old_stale_belief",
      domain: "seo",
      claim: "Old deprecated crawler directive",
      expires_at: now - 1000,
    });

    // 2. Seed 3 successful episodes for topic 'seo.robots_probe'
    for (let i = 1; i <= 3; i++) {
      memoryDb.push({
        id: i,
        task_id: `task_ep_${i}`,
        topic: "seo.robots_probe",
        spec_summary: "Probe robots",
        action_taken: "Evaluated bot status",
        outcome: "Clean pass",
        confidence: 0.95,
        latency_ms: 50,
        created_at: now - 10000,
      });
    }

    const summary = await runSleepConsolidation(mockDb as any, "seo", now);

    assert.equal(summary.beliefsDecayed, 1, "Stale belief must be pruned");
    assert.equal(summary.beliefsSynthesized, 1, "Clustered episodes must synthesize 1 new belief");
    assert.equal(summary.episodesAnalyzed, 3);
    assert.ok(beliefsDb.has("belief_seo_seo_robots_probe"));
  });
});
