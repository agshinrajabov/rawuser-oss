/**
 * Condition 3 of the install-friction ruling (2026-10-03): the hosts the
 * render blocks are one list, tied here to the edge's and the generation
 * worker's wrangler.toml. A route added there without being in the
 * production vars that make the list (OWN_HOSTS, or the origins) fails
 * this test. A file with no production route has nothing to tie.
 */

import { describe, expect, it } from "vitest";
import { WORKER_NAMES, isOwnHost, ownHosts } from "../../src/lib/own-hosts.ts";
import { INSTALL_ENV } from "../install-env.ts";
import {
  EDGE_TOML,
  GENERATION_TOML,
  productionVars,
  routes,
  workerNames,
} from "../wrangler-vars.ts";

/** The list production runs with: generation's own production vars. */
const production = ownHosts(productionVars(GENERATION_TOML));
const edgeRoutes = routes(EDGE_TOML);
const generationRoutes = routes(GENERATION_TOML);

describe("own hosts, tied to the wrangler files", () => {
  it.skipIf(edgeRoutes.length === 0)("blocks every custom domain the edge answers on", () => {
    for (const host of edgeRoutes) {
      expect(production).toContain(host);
      expect(isOwnHost(host, production)).toBe(true);
    }
  });

  it.skipIf(generationRoutes.length === 0)(
    "blocks every custom domain the generation worker answers on",
    () => {
      for (const host of generationRoutes) {
        expect(production).toContain(host);
        expect(isOwnHost(host, production)).toBe(true);
      }
    },
  );

  it("blocks the workers.dev names of both workers, any account subdomain, with nothing configured", () => {
    for (const name of [...workerNames(EDGE_TOML), ...workerNames(GENERATION_TOML)]) {
      expect(WORKER_NAMES).toContain(name);
      expect(isOwnHost(`${name}.some-account.workers.dev`, [])).toBe(true);
      expect(isOwnHost(`${name}.someone-else.workers.dev`, [])).toBe(true);
    }
  });
});

describe("the tie itself, on files that are not ours", () => {
  /** The routes of a file that the list made from its own production vars does not cover. */
  const uncovered = (toml: string) => {
    const hosts = ownHosts(productionVars(toml));
    return routes(toml).filter((host) => !isOwnHost(host, hosts));
  };

  it("a file with no production routes has nothing to tie, and no list is asked of it", () => {
    const template = [
      'name = "rawuser-edge"',
      'main = "src/index.ts"',
      "",
      "[vars]",
      'ENVIRONMENT = "development"',
      "",
      "[env.production]",
      "workers_dev = true",
      "",
    ].join("\n");
    expect(routes(template)).toEqual([]);
    expect(productionVars(template)).toEqual({});
    expect(uncovered(template)).toEqual([]);
    expect(workerNames(template)).toEqual(["rawuser-edge", "rawuser-edge-production"]);
  });

  it("a route the vars cover passes; one they leave out is named", () => {
    const file = (ownHostsVar: string) =>
      [
        'name = "rawuser-generation"',
        "",
        "[[env.production.routes]]",
        'pattern = "api.example.com"',
        "custom_domain = true",
        "",
        "[[env.production.routes]]",
        'pattern = "edge.example.com"',
        "custom_domain = true",
        "",
        "[env.production.vars]",
        "# [env.production.vars] is named in a comment too",
        'ENVIRONMENT = "production"',
        `OWN_HOSTS = "${ownHostsVar}"`,
        "EDGE_ORIGIN = 'https://edge.example.com'",
        "",
        "[env.production.browser]",
        'binding = "BROWSER"',
        'OWN_HOSTS = "not.a.var.of.this.section"',
        "",
      ].join("\n");
    expect(productionVars(file("api.example.com"))).toEqual({
      ENVIRONMENT: "production",
      OWN_HOSTS: "api.example.com",
      EDGE_ORIGIN: "https://edge.example.com",
    });
    // The edge's host comes from EDGE_ORIGIN, the API's from the list.
    expect(uncovered(file("api.example.com"))).toEqual([]);
    expect(uncovered(file("other.example.com"))).toEqual(["api.example.com"]);
  });
});

describe("own hosts, from the install's vars", () => {
  it("is OWN_HOSTS plus the hosts of the edge origin, its aliases and the API origin", () => {
    expect(
      ownHosts({
        OWN_HOSTS: "one.example.com, Two.Example.com",
        EDGE_ORIGIN: "https://edge.example.com",
        EDGE_ORIGIN_ALIASES: "https://edge-old.example.com, https://edge-older.example.com/",
        API_ORIGIN: "https://api.example.com",
      }),
    ).toEqual([
      "one.example.com",
      "two.example.com",
      "edge.example.com",
      "edge-old.example.com",
      "edge-older.example.com",
      "api.example.com",
    ]);
  });

  it("covers an install that set only its origins", () => {
    const hosts = ownHosts({
      EDGE_ORIGIN: "https://edge.example.com",
      API_ORIGIN: "https://api.example.com",
    });
    expect(isOwnHost("edge.example.com", hosts)).toBe(true);
    expect(isOwnHost("API.example.com.", hosts)).toBe(true);
  });

  it("takes an entry written as an origin or with a port as its hostname", () => {
    expect(ownHosts({ OWN_HOSTS: "https://edge.example.com/, localhost:8787" })).toEqual([
      "edge.example.com",
      "localhost",
    ]);
  });

  it("is empty with nothing set: only the workers.dev names are blocked", () => {
    expect(ownHosts({})).toEqual([]);
    expect(isOwnHost("edge.example.com", ownHosts({}))).toBe(false);
    expect(isOwnHost("rawuser-edge-production.some-account.workers.dev", ownHosts({}))).toBe(true);
  });

  it("leaves everyone else alone", () => {
    const hosts = ownHosts(INSTALL_ENV);
    for (const host of [
      "example.com",
      "app.example.com",
      "shop.example.org",
      "some-site.pages.dev",
      "my-rawuser-edge.example.com",
      "other-worker.some-account.workers.dev",
    ]) {
      expect(isOwnHost(host, hosts)).toBe(false);
    }
  });
});
