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

import type { MemberDefinition, ServiceDefinition, ServiceStub, TypeDefinition } from "robotraconteur";
import { primitivesByName } from "robotraconteur/internal";
import type { TypeContext } from "robotraconteur/internal";
import { typeName } from "./codec.js";

const MAX_TYPES = 100;

/**
 * Documentation comments are reStructuredText, where indentation has meaning. Remove only the
 * indentation the lines share, usually the space after each ##, and the blank lines around them.
 */
function doc(text: string): string
{
    const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
    const indents = lines.filter((l) => l.length > 0).map((l) => /^[ \t]*/.exec(l)![0].length);
    const common = indents.length > 0 ? Math.min(...indents) : 0;
    return lines.map((l) => l.slice(common)).join("\n").replace(/^\n+|\n+$/g, "");
}

function direction(m: MemberDefinition): string | undefined
{
    if (m.modifiers?.includes("readonly")) return "readonly";
    if (m.modifiers?.includes("writeonly")) return "writeonly";
    return undefined;
}

function parameters(m: MemberDefinition, skip_generator: boolean): { name: string; type: string; doc?: string }[]
{
    return (m.parameters ?? [])
        .filter((p) => !(skip_generator && p.type.container === "generator"))
        .map((p) => ({ name: p.name, type: typeName(p.type) }));
}

function memberSummary(m: MemberDefinition): Record<string, unknown>
{
    const out: Record<string, unknown> = { kind: m.kind, name: m.name };
    if (m.type) out["type"] = typeName(m.type);
    if (m.parameters) out["parameters"] = parameters(m, false);
    const d = direction(m);
    if (d) out["direction"] = d;
    if (m.docString) out["doc"] = doc(m.docString);
    return out;
}

/** Describes a named type and every type it uses, in the form the tools accept */
function collectTypes(t: TypeDefinition, scope: ServiceDefinition, types: TypeContext, out: Map<string, unknown>): void
{
    if (out.size >= MAX_TYPES || t.type === "void" || t.type === "string" || t.type === "varvalue" || t.type === "varobject" || primitivesByName.has(t.type)) return;
    const r = types.resolve(t.type, scope);
    if (out.has(r.qualifiedName)) return;
    if (r.kind === "enum")
    {
        const e = r.def.enums.find((x) => r.qualifiedName.endsWith("." + x.name))!;
        out.set(r.qualifiedName, { kind: "enum", values: Object.fromEntries(e.values.map((v) => [v.name, v.value])), ...(e.docString ? { doc: doc(e.docString) } : {}) });
        return;
    }
    if (r.kind === "object")
    {
        out.set(r.qualifiedName, { kind: "object" });
        return;
    }
    const entry = r.entry!;
    out.set(r.qualifiedName, {
        kind: r.kind,
        ...(entry.docString ? { doc: doc(entry.docString) } : {}),
        fields: entry.members.map((m) => ({ name: m.name, type: typeName(m.type!), ...(m.docString ? { doc: doc(m.docString) } : {}) }))
    });
    for (const m of entry.members) collectTypes(m.type!, r.def, types, out);
}

/** Describe an object, or one of its members along with the types needed to use it */
export function describeObject(stub: ServiceStub, member?: string): Record<string, unknown>
{
    const context = stub.context;
    const scope = context.serviceDefForType(stub.objectType);
    const short_name = stub.objectType.substring(stub.objectType.lastIndexOf(".") + 1);
    const entry = scope.objects.find((o) => o.name === short_name)!;

    if (member === undefined)
    {
        return {
            objectType: stub.objectType,
            ...(scope.docString ? { serviceDoc: doc(scope.docString) } : {}),
            ...(entry.docString ? { doc: doc(entry.docString) } : {}),
            members: entry.members.map(memberSummary),
            hint: "Call robotraconteur_describe again with member set to see the fields and enum values of the types a member uses."
        };
    }

    const m = entry.members.find((x) => x.name === member);
    if (!m) throw new Error(`${stub.objectType} has no member "${member}". Its members are: ${entry.members.map((x) => x.name).join(", ")}`);

    const types = new Map<string, unknown>();
    if (m.type) collectTypes(m.type, scope, context.types, types);
    for (const p of m.parameters ?? []) collectTypes(p.type, scope, context.types, types);
    return {
        objectType: stub.objectType,
        member: memberSummary(m),
        types: Object.fromEntries(types),
        ...(types.size >= MAX_TYPES ? { truncated: true } : {})
    };
}
