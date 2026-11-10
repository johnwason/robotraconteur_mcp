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

import assert from "node:assert/strict";
import test from "node:test";
import { parseServiceDefinition } from "robotraconteur";
import type { ServiceStub } from "robotraconteur";
import { describeObject } from "../../src/describe.js";

function stub(text: string, object_type: string): ServiceStub
{
    const def = parseServiceDefinition(text);
    return { objectType: object_type, context: { serviceDefForType: () => def } } as unknown as ServiceStub;
}

test("the overview includes the documentation of the service definition", () =>
{
    const d = describeObject(stub(`
## A small robot that moves around a room.
## Positions are in meters from the center of the room.
service example.documented

## The robot
object robot
    ## Move to a position
    function void teleport(double x, double y)
end
`, "example.documented.robot"), undefined);
    assert.equal(d["serviceDoc"], "A small robot that moves around a room.\nPositions are in meters from the center of the room.");
    assert.equal(d["doc"], "The robot");
    assert.deepEqual((d["members"] as { doc?: string }[]).map((m) => m.doc), ["Move to a position"]);
});

test("reStructuredText documentation keeps its indentation", () =>
{
    const d = describeObject(stub(`
service example.rst

object robot
    ## Move the robot to a position.
    ##
    ## :param x: Position along the x axis, in meters.
    ##     Positive is to the right.
    ## :param y: Position along the y axis, in meters.
    ##
    ## Example::
    ##
    ##     teleport(0.5, -0.25)
    ##
    function void teleport(double x, double y)
end
`, "example.rst.robot"), undefined);
    assert.equal((d["members"] as { doc?: string }[])[0]!.doc, [
        "Move the robot to a position.",
        "",
        ":param x: Position along the x axis, in meters.",
        "    Positive is to the right.",
        ":param y: Position along the y axis, in meters.",
        "",
        "Example::",
        "",
        "    teleport(0.5, -0.25)"
    ].join("\n"));
});

test("the overview leaves out documentation that is not there", () =>
{
    const d = describeObject(stub("service example.plain\n\nobject robot\n    property double x\nend\n", "example.plain.robot"), undefined);
    assert.equal("serviceDoc" in d, false);
    assert.equal("doc" in d, false);
});
