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

// The documentation of the standard service definitions, and the note robotraconteur_describe gives
// when a service uses them. Kept apart from help.ts, which imports the sequence runner, so that
// describe.ts can use it without an import cycle.

import { STANDARD_DOCS } from "./standard_docs.js";

/** The service definition a qualified type name belongs to, such as com.robotraconteur.robotics.robot for its Robot */
function serviceOf(qualified_name: string): string
{
    return qualified_name.substring(0, qualified_name.lastIndexOf("."));
}

/** Whether a service definition has a page in the standard documentation */
export function isStandardService(name: string): boolean
{
    return Object.hasOwn(STANDARD_DOCS, name);
}

/**
 * A note for robotraconteur_describe when the types shown come from standard service definitions.
 * For an object, it names the object's own page, which lists the others it imports. For a member, it
 * names the pages of the types that member uses, which are few
 */
export function standardDocsNote(object_type: string, member_type_names?: Iterable<string>): string | undefined
{
    const pages = new Set<string>();
    for (const t of member_type_names ?? [])
    {
        if (isStandardService(serviceOf(t))) pages.add(serviceOf(t));
    }
    if (pages.size === 0 && isStandardService(serviceOf(object_type))) pages.add(serviceOf(object_type));
    if (pages.size === 0) return undefined;
    const list = [...pages];
    const which = list.length === 1 ? `topic ${list[0]}` : `topics ${list.join(", ")}`;
    return `This uses standard service types, whose robdefs carry little documentation. Read robotraconteur_help ${which}; a page lists the types it uses from other services. Category standard_service_types lists them all.`;
}
