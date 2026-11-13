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

function standardIndex(): string
{
    const lines = Object.entries(STANDARD_DOCS).map(([name, d]) => `- ${name}: ${d.summary}`);
    return `## standard_service_types\nThe standard service definitions, used by robots, cameras, sensors, and other devices. Their robdefs carry little documentation, to keep them small, so it is here. Each is a topic by its full name, such as com.robotraconteur.robotics.robot. A page lists the services it imports and the types it uses from them, which are on those services' pages.\n${lines.join("\n")}`;
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
        parts.push(found.kind === "sequence" ? sequenceHelp([found.name]) : STANDARD_DOCS[found.name]!.page);
    }
    if (unknown.length > 0)
    {
        const note = `Unknown topic ${unknown.join(", ")}. The sequence topics are ${HELP_TOPICS.join(", ")}. The standard service definitions are topics by their full names, such as com.robotraconteur.robotics.robot; category standard_service_types lists them.`;
        if (parts.length === 0) throw new Error(note);
        parts.push(`Note: ${note}`);
    }
    return parts.join("\n\n");
}
