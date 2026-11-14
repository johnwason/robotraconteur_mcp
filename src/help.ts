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

// robotraconteur_help: the rules for sequences, and the documentation of the standard service
// definitions, whose robdefs carry few docstrings. Pages are read on demand, so they cost nothing
// until asked for.

import { HELP_TOPIC_SUMMARIES, HELP_TOPICS, sequenceHelp } from "./sequence_help.js";
import type { HelpTopic } from "./sequence_help.js";
import { STANDARD_DOCS } from "./standard_docs.js";
import { isStandardService } from "./standard_help.js";

export const HELP_CATEGORIES = ["sequences", "standard_service_types"] as const;
export type HelpCategory = typeof HELP_CATEGORIES[number];

/** Notes on using a standard service through these tools, which its page does not give, shown first */
const STANDARD_USAGE: Record<string, string> = {
    "com.robotraconteur.robotics.robot": "Usage: command_mode can only change from halt to another mode, or from any mode to halt, so set halt and then trajectory before execute_trajectory. The motion begins at the first next of the generator execute_trajectory returns, and ends with a complete status. A driver may leave joint_velocity, joint_effort, and the command arrays empty when the robot does not report them."
};

/**
 * A standard service's page as served: its usage note first, then the page, with the lists of imports
 * and using statements, which are long, shortened to the types used from each service
 */
function standardPage(name: string): string
{
    let page = STANDARD_DOCS[name]!.page;
    const imports = /\n### Imports\n[\s\S]*?(?=\n#)/.exec(page);
    const using = /\n### Using Statements\n[\s\S]*?(?=\n#)/.exec(page);
    if (imports && using)
    {
        const by_service = new Map<string, string[]>();
        for (const m of using[0].matchAll(/^- `([A-Za-z0-9_.]+)\.([A-Za-z0-9_]+)`/gm))
        {
            const list = by_service.get(m[1]!) ?? [];
            list.push(m[2]!);
            by_service.set(m[1]!, list);
        }
        const lines = [...by_service].map(([service, types]) => `- ${service}: ${types.join(", ")}`);
        page = page.replace(using[0], "").replace(imports[0], `\n### Types used from other services, on their pages\n\n${lines.join("\n")}\n`);
    }
    const usage = STANDARD_USAGE[name];
    return usage ? `${usage}\n\n${page}` : page;
}

function standardIndex(): string
{
    const lines = Object.entries(STANDARD_DOCS).map(([name, d]) => `- ${name}: ${d.summary}`);
    return `## standard_service_types\nThe standard service definitions, used by robots, cameras, sensors, and other devices. Their robdefs carry little documentation, to keep them small, so it is here. Each is a topic by its full name, such as com.robotraconteur.robotics.robot. A page lists the types it uses from other services, which are on those services' pages.\n${lines.join("\n")}`;
}

/** A topic by name, ignoring case: a sequence topic or a standard service definition */
function findTopic(name: string): { kind: "sequence" | "standard"; name: string } | undefined
{
    const lower = name.trim().toLowerCase();
    const sequence = HELP_TOPICS.find((t) => t === lower);
    if (sequence) return { kind: "sequence", name: sequence };
    const standard = Object.keys(STANDARD_DOCS).find((t) => t.toLowerCase() === lower);
    return standard ? { kind: "standard", name: standard } : undefined;
}

/** What each category holds, for the list of categories */
const CATEGORY_SUMMARIES: Record<HelpCategory, string> = {
    sequences: "the rules for robotraconteur_start_sequence, by topic. Read the topics you need before writing your first sequence, such as actions, timing, and stopping",
    standard_service_types: "the standard service definitions that robots, cameras, sensors, and other devices use, each a topic by its full name, such as com.robotraconteur.robotics.robot. Their robdefs carry little documentation, so it is here"
};

function categoryList(): string
{
    const lines = HELP_CATEGORIES.map((c) => `- ${c}: ${CATEGORY_SUMMARIES[c]}`);
    return `## Categories\nAsk for a category to list its topics, then for topics to read them.\n${lines.join("\n")}`;
}

function sequenceTopicList(): string
{
    const lines = HELP_TOPICS.map((t) => `- ${t}: ${HELP_TOPIC_SUMMARIES[t]}`);
    return `## sequences\nThe rules for robotraconteur_start_sequence. Each is a topic; ask for the ones you need, such as { "topics": ["actions", "timing", "stopping"] }.\n${lines.join("\n")}`;
}

/**
 * The help asked for. Topics give their pages, each once, whether or not a category is given. A
 * category alone lists its topics, and an empty request lists the categories. Unknown topics are
 * named in a note after the pages found, and are an error only if none was found
 */
export function help(category?: HelpCategory, topics?: string[]): string
{
    if (!topics?.length)
    {
        if (category === "sequences") return sequenceTopicList();
        if (category === "standard_service_types") return standardIndex();
        return categoryList();
    }
    const parts: string[] = [];
    const given = new Set<string>();
    const unknown: string[] = [];
    for (const t of topics ?? [])
    {
        const found = findTopic(t);
        if (!found)
        {
            if (!unknown.includes(t)) unknown.push(t);
            continue;
        }
        if (given.has(found.name)) continue;
        given.add(found.name);
        parts.push(found.kind === "sequence" ? sequenceHelp([found.name]) : standardPage(found.name));
    }
    if (unknown.length > 0)
    {
        const note = `Unknown topic ${unknown.join(", ")}. The sequence topics are ${HELP_TOPICS.join(", ")}. The standard service definitions are topics by their full names, such as com.robotraconteur.robotics.robot; category standard_service_types lists them.`;
        if (parts.length === 0) throw new Error(note);
        parts.push(`Note: ${note}`);
    }
    return parts.join("\n\n");
}
