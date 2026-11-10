// Copyright 2011-2026 Wason Technology, LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { readFileSync } from "node:fs";
import { RobotRaconteurError, RobotRaconteurNode, subscribeService } from "robotraconteur";
import type { ServiceStub, ServiceSubscription } from "robotraconteur";
import { IPNodeDiscoveryFlags, NodeDiscovery, TcpTransport } from "robotraconteur-node";
import type { ServiceInfo2, ServiceInfo2Subscription, ServiceSubscriptionFilter } from "robotraconteur-node";
import { Codec } from "./codec.js";

export interface BridgeConfig
{
    /** Services at known addresses, used in addition to those found by discovery */
    services?: { name: string; url: string; username?: string; passwordEnv?: string }[];
    /** Only use services of these types. Everything found is used if unset */
    serviceTypes?: string[];
    /** Only use services on these nodes */
    nodeNames?: string[];
    /** Also search using IPv4 broadcast */
    ipv4Discovery?: boolean;
    /** Milliseconds to allow for a request. Motion can take a long time */
    requestTimeout?: number;
}

export function loadConfig(path: string | undefined): BridgeConfig
{
    return path ? (JSON.parse(readFileSync(path, "utf8")) as BridgeConfig) : {};
}

export interface ReceivedEvent
{
    time: string;
    event: string;
    arguments: Record<string, unknown>;
}

const MAX_EVENTS = 200;
const CONNECT_TIMEOUT_MS = 10000;
/** How long a search lasts. A node can take this long to be found */
const SEARCH_WINDOW_MS = 15000;
/** How often nodes are asked to announce themselves during a search, and otherwise */
const SEARCH_POLL_MS = 5000;
const IDLE_POLL_MS = 30000;
/** Requests closer together than this are combined */
const MIN_POLL_SPACING_MS = 1000;

/** A service the AI is using, kept connected by a subscription */
export interface ConnectedService
{
    subscription: ServiceSubscription;
    /** The addresses being used, which change if a service restarts on another port */
    urls: string[];
    /** Why the most recent connection attempt failed, if it did */
    lastError?: unknown;
    events: ReceivedEvent[];
    droppedEvents: number;
}

/** Finds services, gives them short names, and keeps connections to the ones in use */
export class ServiceRegistry
{
    readonly node = new RobotRaconteurNode();
    private tcp = new TcpTransport(this.node);
    private discovery: NodeDiscovery;
    private found: ServiceInfo2Subscription | null = null;
    private connected = new Map<string, ConnectedService>();
    /** The name given to each service, by node ID and service name. Names never change once given */
    private names = new Map<string, string>();
    private search_until = 0;
    private last_poll = 0;
    private poll_timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private config: BridgeConfig)
    {
        this.node.requestTimeout = config.requestTimeout ?? 120000;
        this.node.registerTransport(this.tcp);
        this.discovery = new NodeDiscovery(this.node, this.tcp, {
            flags: IPNodeDiscoveryFlags.LinkLocal | (config.ipv4Discovery ? IPNodeDiscoveryFlags.IPv4Broadcast : 0)
        });
    }

    async start(): Promise<void>
    {
        await this.discovery.start();
        const filter: ServiceSubscriptionFilter = {};
        if (this.config.nodeNames) filter.nodes = this.config.nodeNames.map((nodeName) => ({ nodeName }));
        this.found = this.discovery.subscribeServiceInfo2(this.config.serviceTypes ?? [], filter);
        this.startSearch();
    }

    async close(): Promise<void>
    {
        clearTimeout(this.poll_timer);
        this.discovery.close();
        await this.node.shutdown();
    }

    /** Every service is named node.service, whatever else is on the network, so that names stay valid */
    private named(): Map<string, ServiceInfo2>
    {
        // Every node has this service. It is how discovery itself finds the others
        const infos = (this.found?.getDetectedServiceInfo2() ?? []).filter((i) => i.name !== "RobotRaconteurServiceIndex");
        const out = new Map<string, ServiceInfo2>();
        for (const i of [...infos].sort((a, b) => `${a.nodeName}${a.name}`.localeCompare(`${b.nodeName}${b.name}`)))
        {
            const key = `${i.nodeID.toString()}/${i.name}`;
            let name = this.names.get(key);
            if (!name)
            {
                name = `${i.nodeName || "node"}.${i.name}`;
                // Nodes should have unique names, but nothing enforces it
                if ([...this.names.values()].includes(name)) name = `${name}.${i.nodeID.toString().slice(1, 9)}`;
                this.names.set(key, name);
            }
            out.set(name, i);
        }
        return out;
    }

    /** Find the full name for a name given by the model, which may be just the service name */
    private fullName(name: string): string
    {
        const named = this.named();
        if (named.has(name) || this.config.services?.some((s) => s.name === name) || [...this.names.values()].includes(name)) return name;
        const matches = [...named].filter(([, i]) => i.name === name).map(([n]) => n);
        if (matches.length > 1) throw new Error(`"${name}" matches more than one service: ${matches.join(", ")}. Use one of those names.`);
        return matches[0] ?? name;
    }

    /** Explain a failed connection in terms of what the model can do next */
    private notResponding(name: string): string
    {
        const configured = this.config.services?.find((s) => s.name === name);
        const failure = this.connected.get(name)?.lastError;
        const reason = failure === undefined ? "" : failure instanceof RobotRaconteurError ? ` The last attempt failed with ${failure.errorName}: ${failure.message}.` : ` The last attempt failed with: ${String(failure)}.`;
        if (configured) return `Service "${name}" is not responding. Check that it is running at ${configured.url}.${reason}`;
        if (this.named().has(name)) return `Service "${name}" is announced on the network but could not be connected to.${reason || " It may be starting or busy. Try again shortly."}`;
        return `Service "${name}" is not responding and is no longer announced on the network, so it has probably stopped. Use robotraconteur_discover to see what is available.`;
    }

    /** Whether a service that has not appeared yet may still be found by the search in progress */
    get searching(): boolean
    {
        return Date.now() < this.search_until;
    }

    /** Seconds until it is worth looking at the list again, while a search is in progress */
    get checkAgainAfter(): number
    {
        return Math.ceil(Math.min(SEARCH_POLL_MS, this.search_until - Date.now()) / 1000);
    }

    /** Begin a search in the background. The list of services updates as nodes respond */
    startSearch(): void
    {
        this.search_until = Date.now() + SEARCH_WINDOW_MS;
        this.poll();
    }

    /** Ask nodes to announce themselves, and schedule the next time to ask */
    private poll(): void
    {
        clearTimeout(this.poll_timer);
        if (Date.now() - this.last_poll >= MIN_POLL_SPACING_MS)
        {
            this.last_poll = Date.now();
            this.tcp.sendDiscoveryRequest();
        }
        this.poll_timer = setTimeout(() => this.poll(), this.searching ? SEARCH_POLL_MS : IDLE_POLL_MS);
        this.poll_timer.unref();
    }

    list(): { service: string; info?: ServiceInfo2; url?: string }[]
    {
        const configured = (this.config.services ?? []).map((s) => ({ service: s.name, url: s.url }));
        return [...configured, ...[...this.named()].map(([service, info]) => ({ service, info }))];
    }

    private connectionFor(name: string): { urls: string[]; username?: string; credentials?: Map<string, unknown> }
    {
        const configured = this.config.services?.find((s) => s.name === name);
        if (configured)
        {
            const password = configured.passwordEnv ? process.env[configured.passwordEnv] : undefined;
            return { urls: [configured.url], username: configured.username, credentials: password === undefined ? undefined : new Map([["password", password]]) };
        }
        const info = this.named().get(name);
        if (!info)
        {
            if ([...this.names.values()].includes(name)) throw new Error(this.notResponding(name));
            const known = this.list().map((s) => s.service);
            const still = this.searching ? " The search for services is still running, so it may appear shortly." : "";
            throw new Error(`Unknown service "${name}".${still} ${known.length > 0 ? `Known services: ${known.join(", ")}` : "Use robotraconteur_discover to find services."}`);
        }
        return { urls: info.connectionURLs };
    }

    private attachEvents(service: ConnectedService, client: ServiceStub): void
    {
        const scope = client.context.serviceDefForType(client.objectType);
        const short_name = client.objectType.substring(client.objectType.lastIndexOf(".") + 1);
        const codec = new Codec(client.context.types);
        for (const m of scope.objects.find((o) => o.name === short_name)?.members ?? [])
        {
            if (m.kind !== "event") continue;
            client.addEventListener(m.name, (...values: unknown[]) =>
            {
                service.events.push({
                    time: new Date().toISOString(),
                    event: m.name,
                    arguments: Object.fromEntries((m.parameters ?? []).map((p, i) => [p.name, codec.toJson(values[i], p.type, scope, { maxArray: 32 })]))
                });
                if (service.events.length > MAX_EVENTS)
                {
                    service.events.shift();
                    service.droppedEvents++;
                }
            });
        }
    }

    private connect(given_name: string): ConnectedService
    {
        const name = this.fullName(given_name);
        let service = this.connected.get(name);
        if (service)
        {
            const urls = this.named().get(name)?.connectionURLs;
            if (urls && [...urls].sort().join() !== [...service.urls].sort().join())
            {
                service.urls = urls;
                service.subscription.updateServiceURL(urls);
            }
            return service;
        }
        const c = this.connectionFor(name);
        const created: ConnectedService = { subscription: subscribeService(this.node, c.urls, c.username, c.credentials), urls: c.urls, events: [], droppedEvents: 0 };
        created.subscription.addClientConnectListener((_, __, client) =>
        {
            created.lastError = undefined;
            this.attachEvents(created, client);
        });
        created.subscription.addClientConnectFailedListener((_, __, ___, error) =>
        {
            created.lastError = error;
        });
        this.connected.set(name, created);
        service = created;
        return service;
    }

    /** Get a connected client for a service. An object path such as "arm.tool[0]" selects a sub object */
    async resolve(given_name: string, object?: string): Promise<ServiceStub>
    {
        const name = this.fullName(given_name);
        const root = await this.connect(name).subscription.getDefaultClientWait(CONNECT_TIMEOUT_MS).catch((e: unknown) =>
        {
            if (e instanceof RobotRaconteurError && e.errorName === "RobotRaconteur.ConnectionError") throw new Error(this.notResponding(name));
            throw e;
        });
        let o = root;
        // A dot inside an index is part of the index
        for (const part of object ? object.split(/\.(?![^[]*\])/) : [])
        {
            const m = /^([A-Za-z_]\w*)(?:\[(.*)\])?$/.exec(part);
            if (!m) throw new Error(`Invalid object path "${object}". Use names such as arm or tool[0], separated by dots`);
            const index = m[2];
            o = await o.getObjRef(m[1]!, index === undefined ? undefined : /^-?\d+$/.test(index) ? Number(index) : index);
        }
        return o;
    }

    /** Return the events received so far. The first call starts connecting to the service */
    takeEvents(name: string, clear: boolean, limit: number): { events: ReceivedEvent[]; dropped: number }
    {
        const service = this.connect(name);
        const events = service.events.slice(-limit);
        const dropped = service.droppedEvents;
        if (clear)
        {
            service.events.length = 0;
            service.droppedEvents = 0;
        }
        return { events, dropped };
    }

    /** Describe known services as JSON */
    describeServices(codec_for: (info: ServiceInfo2) => Record<string, unknown>): Record<string, unknown>[]
    {
        return this.list().map((s) => ({ service: s.service, ...(s.info ? codec_for(s.info) : { url: s.url }) }));
    }
}
