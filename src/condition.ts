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

// Conditions on values, written as MongoDB queries, which models already know. mingo evaluates them
// without parsing an expression language. Only the operators listed here are allowed, so a condition
// from the model can never run code, and takes time in proportion to its size and the value's: no
// scripts, no regular expressions, and no operators that loop or build arrays, such as $range, which
// could build a billion elements on every check.

import { Query } from "mingo";

const ALLOWED = new Set([
    // Query operators
    "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$and", "$or", "$nor", "$not", "$exists", "$type",
    "$size", "$all", "$elemMatch", "$mod", "$expr",
    // Arithmetic
    "$abs", "$add", "$ceil", "$divide", "$exp", "$floor", "$ln", "$log", "$log10", "$multiply", "$pow", "$round",
    "$sqrt", "$subtract", "$trunc",
    // Comparison
    "$cmp",
    // Conditional
    "$cond", "$ifNull", "$switch",
    // Type
    "$convert", "$isNumber", "$toBool", "$toDate", "$toDecimal", "$toDouble", "$toInt", "$toLong", "$toString",
    // String
    "$concat", "$indexOfBytes", "$ltrim", "$rtrim", "$trim", "$split", "$strcasecmp", "$strLenBytes", "$strLenCP",
    "$substr", "$substrBytes", "$substrCP", "$toLower", "$toUpper",
    // Arrays, without looping over them
    "$arrayElemAt", "$first", "$last", "$indexOfArray", "$isArray", "$slice", "$concatArrays", "$reverseArray",
    "$sum", "$avg", "$min", "$max",
    // Other
    "$literal", "$let", "$getField"
]);

const REFUSED_HELP = "Conditions can use the query operators, and in $expr arithmetic, comparison, logical, conditional, type, string, and simple array operators, but not operators that run code, use regular expressions, or loop over or build arrays, such as $map, $filter, $reduce, and $range.";

function findRefused(x: unknown): string | undefined
{
    if (Array.isArray(x))
    {
        for (const v of x)
        {
            const found = findRefused(v);
            if (found) return found;
        }
        return undefined;
    }
    if (typeof x !== "object" || x === null) return undefined;
    for (const [k, v] of Object.entries(x))
    {
        if (k.startsWith("$") && !ALLOWED.has(k)) return k;
        const found = findRefused(v);
        if (found) return found;
    }
    return undefined;
}

/**
 * The document a condition is tested against: a JSON object, such as a structure, is queried by its
 * fields. Anything else, such as a number or an array, is queried as the field value
 */
export function conditionDocument(value: unknown): Record<string, unknown>
{
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    return { value };
}

/** Check a condition and return a test for values. Throws with an explanation if it is not valid */
export function compileCondition(condition: unknown): (value: unknown) => boolean
{
    if (typeof condition !== "object" || condition === null || Array.isArray(condition))
    {
        throw new Error("condition must be an object: a MongoDB query, such as { \"joint_position.0\": { \"$gte\": 0.29 } }.");
    }
    const refused = findRefused(condition);
    if (refused) throw new Error(`${refused} is not allowed in a condition. ${REFUSED_HELP}${refused.startsWith("$regex") ? ` To match text in any case, use $expr with $toLower, such as { "$expr": { "$eq": [{ "$toLower": "$message" }, "stop"] } }, or to find it within the text, $indexOfBytes, such as { "$expr": { "$gte": [{ "$indexOfBytes": [{ "$toLower": "$message" }, "stop"] }, 0] } }.` : ""}`);
    let query: Query;
    try
    {
        query = new Query(condition as Record<string, unknown>, { scriptEnabled: false });
    }
    catch (e)
    {
        throw new Error(`The condition is not a valid MongoDB query: ${(e as Error).message}.`);
    }
    return (value) => query.test(conditionDocument(value));
}
