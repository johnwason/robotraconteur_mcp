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

/** The help asked for: a category, topics, or both. With neither, the sequences category */
export function help(category?: HelpCategory, topics?: string[]): string
{
    const parts: string[] = [];
    if (category === "standard_service_types") parts.push(standardIndex());
    if (category === "sequences" || (category === undefined && !topics?.length)) parts.push(sequenceHelp());
    const unknown: string[] = [];
    for (const t of topics ?? [])
    {
        if (HELP_TOPICS.includes(t as HelpTopic)) parts.push(sequenceHelp([t]));
        else if (isStandardService(t)) parts.push(STANDARD_DOCS[t]!.page);
        else unknown.push(t);
    }
    if (unknown.length > 0)
    {
        throw new Error(`Unknown topic ${unknown.join(", ")}. The sequence topics are ${HELP_TOPICS.join(", ")}. The standard service definitions are topics by their full names, such as com.robotraconteur.robotics.robot; category standard_service_types lists them.`);
    }
    return parts.join("\n\n");
}
