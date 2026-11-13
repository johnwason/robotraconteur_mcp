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

import { HELP_TOPICS, sequenceHelp } from "./sequence_help.js";
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

/**
 * The help asked for: a category, topics, or both, each page once. With neither, or with an empty
 * list of topics, the sequences category. Unknown topics are named in a note after the pages found,
 * and are an error only if no topic was found
 */
export function help(category?: HelpCategory, topics?: string[]): string
{
    const parts: string[] = [];
    const given = new Set<string>();
    if (category === "standard_service_types") parts.push(standardIndex());
    if (category === "sequences" || (category === undefined && !topics?.length))
    {
        parts.push(sequenceHelp());
        for (const t of HELP_TOPICS) given.add(t);
    }
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
