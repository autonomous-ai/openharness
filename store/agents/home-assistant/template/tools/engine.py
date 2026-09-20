"""Run one declared scenario in official Home Assistant Core, never a real home.

The automation, trigger, condition, script, service and trace implementations are
upstream Core. Only the clock and explicitly declared device entities are test
doubles. Every invocation is a fresh process/config directory; no integrations
are discovered and no account is loaded. After trusted dependency bootstrap,
scenario execution has no network/subprocess access.
"""
import asyncio
from contextlib import nullcontext
from datetime import datetime, timedelta, UTC
import importlib.metadata
import json
import logging
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import traceback

CORE_VERSION = "2026.9.3"
ENTITY = re.compile(r"^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9_]*$")
IDENTIFIER = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
MAX_BYTES = 3 * 1024 * 1024
MAX_CALLBACKS = 12000


def require(ok, message):
    if not ok:
        raise ValueError(message)


def text(value, label, maximum=4000):
    require(isinstance(value, str) and 0 < len(value) <= maximum, label + " must be nonempty text.")
    return value


def number(value, label, low=0, high=172800):
    require(type(value) in (int, float) and math.isfinite(value) and low <= value <= high,
            label + f" must be a finite number between {low} and {high}.")
    return value


def object_(value, label):
    require(isinstance(value, dict), label + " must be an object.")
    return value


def keys(value, allowed, label):
    object_(value, label)
    require(not (set(value) - set(allowed)), label + ": unknown fields " + ", ".join(set(value) - set(allowed)))


def state_spec(value, label):
    keys(value, ("state", "attributes"), label)
    text(value.get("state"), label + ".state", 255)
    attrs = value.get("attributes", {})
    object_(attrs, label + ".attributes")
    require(len(json.dumps(attrs)) <= 16000, label + ": attributes exceed 16 KB.")


def fixture_state(value, entity):
    label, kind = entity["id"], entity["kind"]
    state_spec(value, label)
    state, attrs = value["state"], value.get("attributes", {})
    if kind in ("light", "fan", "switch", "input_boolean"):
        allowed = ("on", "off") if kind == "input_boolean" else ("on", "off", "unavailable")
        require(state in allowed, label + ": unsupported fixture state " + state + ".")
    if kind == "input_number":
        number(float(state), label + " value", -1000000, 1000000)
    if kind != "state":
        allowed = {"brightness"} if kind == "light" else {"percentage"} if kind == "fan" else set()
        require(not set(attrs) - allowed, label + ": attributes cannot override native fixture capabilities.")
        if "brightness" in attrs:
            require(type(attrs["brightness"]) is int, "Light brightness must be an integer.")
            number(attrs["brightness"], "Light brightness", 0, 255)
        if "percentage" in attrs:
            number(attrs["percentage"], "Fan percentage", 0, 100)
            require(state == "unavailable" or (state == "on") == (attrs["percentage"] > 0),
                    "Fan state and percentage must agree: off is 0%, on is greater than 0%.")


def validate_project(project):
    keys(project, ("spec", "title", "brief", "example", "timezone", "latitude", "longitude",
                   "entities", "scenarios", "notes"), "project")
    require(project.get("spec") == 1, "Unsupported Habitat project version.")
    text(project.get("title"), "Project title", 120)
    text(project.get("brief"), "Project brief", 8000)
    require(type(project.get("example")) is bool, "State whether the devices are examples.")
    text(project.get("timezone"), "Time zone", 80)
    from zoneinfo import ZoneInfo
    ZoneInfo(project["timezone"])
    number(project.get("latitude", 0), "Latitude", -90, 90)
    number(project.get("longitude", 0), "Longitude", -180, 180)
    require(isinstance(project.get("notes", ""), str) and len(project.get("notes", "")) <= 16000, "Keep notes under 16 KB.")
    entities = project.get("entities")
    require(isinstance(entities, list) and 1 <= len(entities) <= 100, "Declare 1–100 example/fixture entities.")
    seen = set()
    for entity in entities:
        keys(entity, ("id", "name", "kind", "state", "attributes"), "Entity")
        entity_id = entity.get("id", "")
        require(isinstance(entity_id, str) and ENTITY.fullmatch(entity_id) and entity_id not in seen, "Entity IDs must be valid and unique.")
        seen.add(entity_id)
        text(entity.get("name"), entity_id + " name", 120)
        kind = entity.get("kind")
        require(kind in ("state", "light", "fan", "switch", "input_boolean", "input_number"), entity_id + ": unsupported fixture kind.")
        if kind != "state":
            require(entity_id.split(".")[0] == kind, entity_id + ": kind must match the entity domain.")
        else:
            require(entity_id.split(".")[0] not in ("automation", "script", "light", "fan", "switch", "input_boolean", "input_number"),
                    entity_id + ": use its real entity fixture kind.")
        fixture_state({"state": entity.get("state"), "attributes": entity.get("attributes", {})}, entity)
    by_id = {e["id"]: e for e in entities}
    cases = project.get("scenarios")
    require(isinstance(cases, list) and 1 <= len(cases) <= 24, "Declare 1–24 test scenarios.")
    case_ids = set()
    for case in cases:
        keys(case, ("id", "name", "why", "start", "initial", "steps", "until", "expect"), "Scenario")
        require(isinstance(case.get("id"), str) and IDENTIFIER.fullmatch(case["id"]) and case["id"] not in case_ids, "Scenario IDs must be unique lowercase identifiers.")
        case_ids.add(case["id"])
        text(case.get("name"), "Scenario name", 160)
        text(case.get("why"), "What the scenario tests", 2000)
        start = datetime.fromisoformat(text(case.get("start"), "Scenario start", 40).replace("Z", "+00:00"))
        require(start.tzinfo is not None and 2000 <= start.year <= 2099, "Scenario starts need a UTC offset and a year from 2000–2099.")
        until = number(case.get("until"), "Scenario duration")
        initial = case.get("initial", {})
        object_(initial, "Scenario initial states")
        for entity_id, value in initial.items():
            require(entity_id in seen, "Undeclared initial entity: " + entity_id)
            fixture_state(value, by_id[entity_id])
        steps = case.get("steps")
        require(isinstance(steps, list) and len(steps) <= 120, "A scenario can have at most 120 timeline events.")
        previous = -1
        for step in steps:
            keys(step, ("at", "entity", "state", "attributes", "event", "data"), "Timeline event")
            at = number(step.get("at"), "Event time", 0, until)
            require(at >= previous, "Timeline events must be in chronological order.")
            previous = at
            if "entity" in step:
                require("event" not in step and "data" not in step and step["entity"] in seen, "State events need a declared entity and no event/data fields.")
                fixture_state({"state": step.get("state"), "attributes": step.get("attributes", {})}, by_id[step["entity"]])
            else:
                require("state" not in step and "attributes" not in step, "Custom events cannot contain state fields.")
                event = text(step.get("event"), "Event type", 100)
                require(re.fullmatch(r"[a-z][a-z0-9_]{0,99}", event) and not event.startswith(("homeassistant_", "state_", "service_", "component_", "automation_")) and event != "call_service",
                        "Use a custom event, not a Home Assistant lifecycle/internal event.")
                object_(step.get("data", {}), "Event data")
        expect = case.get("expect")
        keys(expect, ("calls", "states", "pending"), "Expected result")
        require(isinstance(expect.get("calls"), list) and len(expect["calls"]) <= 200, "Declare the exact expected service-call sequence, including [] for no calls.")
        for call in expect["calls"]:
            keys(call, ("service", "entities", "data", "between"), "Expected call")
            require(isinstance(call.get("service"), str) and ENTITY.fullmatch(call["service"]), "Expected call needs domain.service.")
            require(isinstance(call.get("entities", []), list) and all(e in seen for e in call.get("entities", [])), "Expected targets must be declared entity IDs.")
            object_(call.get("data", {}), "Expected call data")
            window = call.get("between")
            require(isinstance(window, list) and len(window) == 2, "Each expected call needs a [first, last] time window in seconds.")
            number(window[0], "First expected time", 0, until)
            number(window[1], "Last expected time", window[0], until)
        object_(expect.get("states", {}), "Expected final states")
        for entity_id, value in expect.get("states", {}).items():
            require(entity_id in seen, "Undeclared expected entity: " + entity_id)
            state_spec(value, entity_id)
        require(type(expect.get("pending", 0)) is int and 0 <= expect.get("pending", 0) <= 100, "Expected pending runs must be an integer from 0–100.")
    return project


def parse_source(source, declared):
    """Use Core's actual annotated YAML loader, with stricter input boundaries."""
    import yaml
    from annotatedyaml import parse_yaml
    text(source, "Automation YAML", 512 * 1024)
    require(len(source.encode()) <= 512 * 1024, "Automation YAML exceeds 512 KiB.")
    allowed = {"tag:yaml.org,2002:" + t for t in ("str", "int", "float", "bool", "null", "seq", "map")}
    require(sum(isinstance(event, yaml.events.AliasEvent) for event in yaml.parse(source)) <= 30, "Too many YAML aliases.")
    node = yaml.compose(source)
    active = set()
    visits = 0
    def check(current, depth=0):
        nonlocal visits
        visits += 1
        require(current is not None and visits <= 20000 and depth <= 40, "YAML structure is too large/deep.")
        require(id(current) not in active, "Recursive YAML aliases are not supported.")
        require(current.tag in allowed, "YAML includes, secrets, tags and merge keys are not accepted in a portable automation file.")
        active.add(id(current))
        if isinstance(current, yaml.MappingNode):
            mapping_keys = set()
            for key, value in current.value:
                require(isinstance(key, yaml.ScalarNode) and key.tag == "tag:yaml.org,2002:str", "YAML mapping keys must be text.")
                require(key.value not in mapping_keys, "Duplicate YAML key: " + key.value)
                mapping_keys.add(key.value)
                check(value, depth + 1)
        elif isinstance(current, yaml.SequenceNode):
            for value in current.value:
                check(value, depth + 1)
        active.remove(id(current))
    check(node)
    rules = parse_yaml(source)
    require(isinstance(rules, list) and 1 <= len(rules) <= 32, "automations.yaml must contain 1–32 automations.")
    from jinja2 import Environment, nodes
    template_parser = Environment()
    def reference(value):
        require(isinstance(value, str) and value in declared, "Undeclared entity reference: " + str(value))
    def template_references(value):
        if "{{" not in value and "{%" not in value:
            return
        parsed = template_parser.parse(value)
        for call in parsed.find_all(nodes.Call):
            if isinstance(call.node, nodes.Name) and call.node.name in ("states", "is_state", "state_attr", "is_state_attr", "has_value", "expand"):
                for arg in call.args if call.node.name == "expand" else call.args[:1]:
                    if isinstance(arg, nodes.Const) and isinstance(arg.value, str):
                        reference(arg.value)
                    elif isinstance(arg, (nodes.List, nodes.Tuple)):
                        for item in arg.items:
                            if isinstance(item, nodes.Const) and isinstance(item.value, str):
                                reference(item.value)
        for attr in parsed.find_all(nodes.Getattr):
            if isinstance(attr.node, nodes.Getattr) and isinstance(attr.node.node, nodes.Name) and attr.node.node.name == "states":
                reference(attr.node.attr + "." + attr.attr)
    ids = set()
    aliases = set()
    for rule in rules:
        object_(rule, "Automation")
        ident = text(rule.get("id"), "Automation ID", 120)
        alias = text(rule.get("alias"), "Automation alias", 200)
        require(ident not in ids and alias.casefold() not in aliases, "Automation IDs and aliases must be unique.")
        ids.add(ident)
        aliases.add(alias.casefold())
        require("use_blueprint" not in rule, "Expand blueprint inputs into portable automation YAML before testing.")
        require(rule.get("initial_state") is False, "Keep initial_state: false in each automation. The lab arms it locally; an import must not enable devices without review.")
        def walk(value, level=0):
            require(level <= 40, "Automation nesting is too deep.")
            if isinstance(value, dict):
                if "trigger" in value or "platform" in value:
                    kind = value.get("trigger", value.get("platform"))
                    if isinstance(kind, str):
                        require(kind in ("state", "numeric_state", "time", "time_pattern", "template", "event", "sun"),
                                "This isolated lab has no external trigger adapter for " + kind + ".")
                for k, v in value.items():
                    require(k not in ("device_id", "area_id", "floor_id", "label_id"), "Use explicit entity targets in this isolated lab, not device/area/label selectors.")
                    if k == "entity_id":
                        for item in v if isinstance(v, list) else [v]:
                            if isinstance(item, str) and "{{" not in item and "{%" not in item:
                                for target in item.split(","):
                                    reference(target.strip())
                    walk(v, level + 1)
            elif isinstance(value, list):
                for v in value:
                    walk(v, level + 1)
            elif isinstance(value, str):
                template_references(value)
        walk(rule)
    return rules


def subset(expected, actual):
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(k in actual and subset(v, actual[k]) for k, v in expected.items())
    return expected == actual


def assertions(case, calls, final_states, pending, errors):
    checks = []
    def add(name, passed, expected, actual):
        checks.append({"name": name, "passed": bool(passed), "expected": expected, "actual": actual})
    expected = case["expect"]
    add("Exact number of service calls", len(calls) == len(expected["calls"]), len(expected["calls"]), len(calls))
    for index, wanted in enumerate(expected["calls"]):
        actual = calls[index] if index < len(calls) else None
        valid = actual is not None and wanted["service"] == actual["service"] and sorted(wanted.get("entities", [])) == sorted(actual["entities"]) and subset(wanted.get("data", {}), actual["data"]) and wanted["between"][0] - 0.002 <= actual["at"] <= wanted["between"][1] + 0.002
        add("Call " + str(index + 1), valid, wanted, actual)
    for entity_id, wanted in expected.get("states", {}).items():
        actual = final_states.get(entity_id)
        add("Final " + entity_id, subset(wanted, actual), wanted, actual)
    add("Runs still waiting at the end", pending == expected.get("pending", 0), expected.get("pending", 0), pending)
    add("No engine execution errors", not errors, [], errors)
    return checks


def install_guards(config_root):
    """Defense in depth; this process loads only official, selected components."""
    root = str(Path(config_root).resolve()) + os.sep
    blocked = []
    def audit(event, args):
        if event in {"socket.connect", "socket.bind", "socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr", "socket.sendto", "socket.sendmsg", "subprocess.Popen", "os.system", "os.posix_spawn", "os.exec", "os.fork"}:
            frame = sys._getframe(1)
            callers = []
            while frame and len(callers) < 6:
                callers.append(str(frame.f_globals.get("__name__", "")) + "." + frame.f_code.co_name)
                frame = frame.f_back
            blocked.append(event + " via " + " → ".join(callers))
            raise PermissionError("The isolated engine does not allow " + event)
        if event == "open":
            path, mode, flags = args
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC))
            if writing and isinstance(path, (str, bytes, os.PathLike)) and not str(Path(os.fsdecode(path)).resolve()).startswith(root):
                blocked.append("write outside test directory")
                raise PermissionError("The isolated engine only writes to its temporary configuration.")
    sys.addaudithook(audit)
    return blocked


async def run_case(request, rules, case, frozen, folder, blocked):
    # Import Core before voluptuous: Core installs its pinned validation backend.
    from homeassistant import config_entries, loader
    from homeassistant.core import HomeAssistant, CoreState, callback
    from homeassistant.const import EVENT_CALL_SERVICE, EVENT_STATE_CHANGED
    from homeassistant.helpers import entity, condition, trigger
    from homeassistant.helpers.entity_component import DATA_INSTANCES
    from homeassistant.helpers import area_registry, category_registry, device_registry, entity_registry, floor_registry, issue_registry, label_registry, restore_state
    from homeassistant.helpers.json import ExtendedJSONEncoder
    from homeassistant.setup import async_setup_component
    from homeassistant.components import light, fan, switch
    from homeassistant.components.light import LightEntity, ColorMode, LightEntityFeature
    from homeassistant.components.fan import FanEntity, FanEntityFeature
    from homeassistant.components.switch import SwitchEntity
    from homeassistant.components.automation.config import async_validate_config_item
    from homeassistant.components.automation import DATA_COMPONENT as AUTOMATIONS
    from homeassistant.components.trace.const import DATA_TRACE
    from homeassistant.util.async_ import get_scheduled_timer_handles

    project = request["project"]
    start = datetime.fromisoformat(case["start"].replace("Z", "+00:00")).astimezone(UTC)
    now = lambda: round((datetime.now(UTC) - start).total_seconds(), 6)
    calls, changes, effects, errors = [], [], [], []
    class LogErrors(logging.Handler):
        def emit(self, record):
            if record.levelno >= logging.ERROR:
                errors.append(record.getMessage()[:1500])
    handler = LogErrors()
    logging.getLogger("homeassistant").addHandler(handler)
    hass = HomeAssistant(folder)
    hass.config.skip_pip = True
    hass.config.skip_pip_packages = []
    hass.config.latitude = project.get("latitude", 0)
    hass.config.longitude = project.get("longitude", 0)
    hass.config.elevation = 0
    hass.config.location_name = "Habitat isolated test"
    hass.config_entries = config_entries.ConfigEntries(hass, {"habitat": {}})
    hass.config_entries._initialized.set()
    hass.data[loader.DATA_CUSTOM_COMPONENTS] = {}
    await hass.config.async_set_time_zone(project["timezone"])
    entity.async_setup(hass)
    loader.async_setup(hass)
    await condition.async_setup(hass)
    await trigger.async_setup(hass)
    device_registry.async_setup(hass)
    for registry in (area_registry, category_registry, device_registry, entity_registry, floor_registry, issue_registry, label_registry, restore_state):
        # Native ephemeral registries: no previous home state is imported and
        # registry persistence is not part of a device-free logic test. Core's
        # load_empty API also makes the backing stores read-only. This avoids
        # retaining orjson storage fragments into interpreter teardown (the
        # pinned Fragment instances do not retain their heap type).
        # Do not bypass Core shutdown or accept a crashed child's partial result.
        await registry.async_load(hass, load_empty=True)
    hass.set_state(CoreState.running)
    fixtures = {}
    known = {item["id"]: item for item in project["entities"]}
    values = {item["id"]: {"state": item["state"], "attributes": item.get("attributes", {})} for item in project["entities"]}
    for entity_id, value in case.get("initial", {}).items():
        values[entity_id] = {"state": value["state"], "attributes": {**values[entity_id]["attributes"], **value.get("attributes", {})}}

    class Fixture:
        _attr_should_poll = False
        def seed(self, item):
            self.entity_id = item["id"]
            self._attr_unique_id = "habitat-" + item["id"]
            self._attr_name = item["name"]
            self._attr_available = values[self.entity_id]["state"] != "unavailable"
            self._attr_is_on = values[self.entity_id]["state"] == "on"
            self._attr_extra_state_attributes = {}
        def effect(self, action, data):
            effects.append({"at": now(), "entity": self.entity_id, "action": action, "data": data})
            require(len(effects) <= 500, "Too many device effects.")
            self.async_write_ha_state()

    class TestLight(Fixture, LightEntity):
        _attr_supported_color_modes = {ColorMode.BRIGHTNESS}
        _attr_color_mode = ColorMode.BRIGHTNESS
        _attr_supported_features = LightEntityFeature.TRANSITION
        _attr_brightness = 255
        async def async_turn_on(self, **kwargs):
            self._attr_is_on = True
            self._attr_brightness = kwargs.get("brightness", self._attr_brightness)
            self.effect("turn_on", kwargs)
        async def async_turn_off(self, **kwargs):
            self._attr_is_on = False
            self.effect("turn_off", kwargs)

    class TestFan(Fixture, FanEntity):
        _attr_supported_features = FanEntityFeature.TURN_ON | FanEntityFeature.TURN_OFF | FanEntityFeature.SET_SPEED
        _attr_percentage = 0
        async def async_turn_on(self, percentage=None, preset_mode=None, **kwargs):
            require(preset_mode is None, "The fan fixture has no preset-mode adapter.")
            self._attr_is_on = True
            self._attr_percentage = percentage if percentage is not None else 100
            self.effect("turn_on", {"percentage": self._attr_percentage})
        async def async_turn_off(self, **kwargs):
            self._attr_is_on = False
            self._attr_percentage = 0
            self.effect("turn_off", kwargs)
        async def async_set_percentage(self, percentage):
            self._attr_percentage = percentage
            self._attr_is_on = percentage > 0
            self.effect("set_percentage", {"percentage": percentage})

    class TestSwitch(Fixture, SwitchEntity):
        async def async_turn_on(self, **kwargs):
            self._attr_is_on = True
            self.effect("turn_on", kwargs)
        async def async_turn_off(self, **kwargs):
            self._attr_is_on = False
            self.effect("turn_off", kwargs)

    for kind, module, cls in (("light", light, TestLight), ("fan", fan, TestFan), ("switch", switch, TestSwitch)):
        selected = [item for item in project["entities"] if item["kind"] == kind]
        if not selected:
            continue
        require(await async_setup_component(hass, kind, {}), "Core failed to initialize " + kind + ".")
        objects = []
        for item in selected:
            fixture = cls()
            fixture.seed(item)
            fixtures[item["id"]] = fixture
            objects.append(fixture)
        await hass.data[module.DATA_COMPONENT].async_add_entities(objects)
    for kind in ("input_boolean", "input_number"):
        selected = [item for item in project["entities"] if item["kind"] == kind]
        if not selected:
            continue
        config = {}
        for item in selected:
            value = values[item["id"]]["state"]
            require(value != "unavailable", kind + " fixtures need a usable initial state.")
            config[item["id"].split(".")[1]] = {"name": item["name"], "initial": value == "on"} if kind == "input_boolean" else {"name": item["name"], "initial": float(value), "min": -1000000, "max": 1000000, "mode": "box", "step": 0.1}
        require(await async_setup_component(hass, kind, {kind: config}), "Core failed to initialize " + kind + ".")
        for item in selected:
            fixtures[item["id"]] = hass.data[DATA_INSTANCES][kind].get_entity(item["id"])
            require(fixtures[item["id"]] is not None, "Missing native helper: " + item["id"])
    require(await async_setup_component(hass, "persistent_notification", {}), "Core could not initialize local notifications.")

    async def change(entity_id, value):
        state = value["state"]
        attrs = {**values[entity_id].get("attributes", {}), **value.get("attributes", {})}
        values[entity_id] = {"state": state, "attributes": attrs}
        kind = known[entity_id]["kind"]
        fixture = fixtures.get(entity_id)
        if kind in ("light", "fan", "switch"):
            require(state in ("on", "off", "unavailable"), entity_id + ": invalid actuator state.")
            fixture._attr_available = state != "unavailable"
            fixture._attr_is_on = state == "on"
            if kind == "light":
                fixture._attr_brightness = attrs.get("brightness", 255)
            if kind == "fan":
                fixture._attr_percentage = (attrs.get("percentage") or 100) if state == "on" else 0
            fixture.async_write_ha_state()
        elif kind == "input_boolean":
            require(state in ("on", "off"), entity_id + ": helpers accept on/off, not a device availability simulation.")
            await (fixture.async_turn_on() if state == "on" else fixture.async_turn_off())
        elif kind == "input_number":
            await fixture.async_set_native_value(float(state))
        else:
            hass.states.async_set(entity_id, state, attrs)
    for entity_id, value in values.items():
        await change(entity_id, value)

    # The same per-item validator used by Core's automation editor. No approximate
    # trigger/condition/script interpreter or rewritten test-only automation.
    for rule in rules:
        checked = await async_validate_config_item(hass, "automation", rule)
        require(checked is not None and str(checked.validation_status) == "ok", "Core rejected automation " + rule["id"])
    require(await async_setup_component(hass, "automation", {"automation": rules}), "Core automation setup failed.")
    await hass.async_block_till_done()
    component = hass.data[AUTOMATIONS]
    loaded = list(component.entities)
    require({item.unique_id for item in loaded} == {rule["id"] for rule in rules}, "Core did not load every automation.")
    # Exported source stays disabled on import. Arm only this isolated instance.
    for item in loaded:
        await item.async_turn_on()
    await hass.async_block_till_done()
    require(not errors, "Core setup errors: " + "; ".join(errors))

    @callback
    def service_called(event):
        data = dict(event.data.get("service_data", {}))
        targets = data.pop("entity_id", [])
        if isinstance(targets, str):
            targets = [targets]
        calls.append({"at": now(), "service": event.data["domain"] + "." + event.data["service"],
                      "entities": targets, "data": data, "context": event.context.id,
                      "parent": event.context.parent_id})
        if any(target not in known for target in targets):
            errors.append("A service targeted an undeclared entity: " + ", ".join(targets))
        require(len(calls) <= 200, "More than 200 service calls; possible loop.")
    @callback
    def state_changed(event):
        entity_id = event.data["entity_id"]
        if entity_id in known:
            state = event.data["new_state"]
            changes.append({"at": now(), "entity": entity_id, "state": state.state if state else None,
                            "attributes": dict(state.attributes) if state else {}})
            require(len(changes) <= 2500, "More than 2500 state changes; possible loop.")
    unsub_service = hass.bus.async_listen(EVENT_CALL_SERVICE, service_called)
    unsub_states = hass.bus.async_listen(EVENT_STATE_CHANGED, state_changed)
    if frozen is None:
        # Independent short real-clock checks use normal asyncio, without any
        # time travel. Start measurement only after Core setup has completed.
        start = datetime.now(UTC)
        real_start = time.monotonic()

    # Advance real asyncio TimerHandles chronologically; execute each native
    # callback once. The controlled wall and event-loop clocks agree. Never
    # leap over chained delays or manufacture a trigger event. Native datetime
    # types are retained, including Core's captured utcnow partial.
    async def settle():
        quiet = 0
        for _ in range(500):
            await asyncio.sleep(0)
            if not hass.loop._ready:
                quiet += 1
                if quiet == 3:
                    return
            else:
                quiet = 0
        raise RuntimeError("The event loop did not settle; possible zero-delay loop.")
    callbacks = 0
    async def advance(seconds):
        nonlocal callbacks
        if frozen is None:
            await asyncio.sleep(max(0, real_start + seconds - time.monotonic()))
            await settle()
            return
        target = start.timestamp() + seconds
        while True:
            handles = [h for h in get_scheduled_timer_handles(hass.loop) if not h.cancelled()]
            next_time = min((h.when() for h in handles), default=target + 1)
            if next_time > target:
                break
            callbacks += 1
            require(callbacks <= MAX_CALLBACKS, "Scenario exceeds its native timer budget.")
            frozen.shift(max(0, next_time - hass.loop.time()) + 0.000001)
            await settle()
        frozen.shift(max(0, target - hass.loop.time()))
        await settle()
    for step in case["steps"]:
        await advance(step["at"])
        if "entity" in step:
            await change(step["entity"], {"state": step["state"], "attributes": step.get("attributes", {})})
        else:
            hass.bus.async_fire(step["event"], step.get("data", {}))
        await settle()
    await advance(case["until"])
    traces = [item.as_extended_dict() for bucket in hass.data.get(DATA_TRACE, {}).values() for item in bucket.all_traces()]
    pending = sum(item.action_script.runs for item in loaded)
    final_states = {entity_id: {"state": hass.states.get(entity_id).state, "attributes": dict(hass.states.get(entity_id).attributes)} for entity_id in known}
    for trace in traces:
        if trace.get("error"):
            errors.append(trace["error"])
    # urllib3 probes IPv6 support during import by binding ::1. Deny that probe
    # too, and disclose it; its caught "IPv6 unavailable" result is not an
    # automation error. No other attempted operation is excused.
    setup_probe = "socket.bind via urllib3.util.connection._has_ipv6 →"
    errors.extend("Isolation blocked " + item for item in blocked if not item.startswith(setup_probe))
    checks = assertions(case, calls, final_states, pending, list(dict.fromkeys(errors)))
    result = {"scenario": case["id"], "name": case["name"], "passed": all(item["passed"] for item in checks),
              "checks": checks, "calls": calls, "effects": effects, "changes": changes,
              "states": final_states, "traces": traces, "pending": pending, "timerTicks": callbacks,
              "rules": [{"id": rule["id"], "alias": rule["alias"]} for rule in rules],
              "engine": {"name": "Home Assistant Core", "version": CORE_VERSION, "python": sys.version.split()[0],
                         "clock": "real UTC + normal asyncio" if frozen is None else "controlled UTC + event-loop clock; chronological native asyncio callbacks",
                         "devices": "declared test doubles and native local helpers; no physical devices",
                         "storage": "native load_empty registries; non-persistent; restart/restore behavior is not tested",
                         "network": "denied", "blockedOperations": blocked,
                         "components": sorted(hass.config.components)}}
    # Snapshot before shutdown: no lifecycle behavior is represented as tested.
    encoded = json.dumps(result, cls=ExtendedJSONEncoder, allow_nan=False)
    require(len(encoded.encode()) <= 8 * 1024 * 1024, "Engine result exceeds 8 MiB.")
    unsub_service()
    unsub_states()
    await hass.async_stop(force=True)
    logging.getLogger("homeassistant").removeHandler(handler)
    return encoded


def main():
    raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    require(len(raw) <= MAX_BYTES, "Engine request exceeds 3 MiB.")
    request = json.loads(raw, parse_constant=lambda x: (_ for _ in ()).throw(ValueError("Non-finite JSON: " + x)))
    validate_project(request.get("project"))
    require(sys.version_info[:3] == (3, 14, 7), "Run setup: this lab is pinned to Python 3.14.7.")
    require(importlib.metadata.version("homeassistant") == CORE_VERSION, "Run setup: Home Assistant Core must be " + CORE_VERSION + ".")
    require(importlib.metadata.version("time-machine") == "3.5.0", "Run setup: time-machine must be 3.5.0.")
    case = next((c for c in request["project"]["scenarios"] if c["id"] == request.get("scenario")), None)
    require(case is not None, "Choose a declared scenario.")
    real_clock = request.get("clock") == "realtime"
    require(not real_clock or case["until"] <= 5, "Real-clock comparison cases are limited to five seconds.")
    import time_machine
    # One invocation per scenario makes module-level clock bindings and state
    # truly fresh. Never reuse a Home Assistant object between independent tests.
    with tempfile.TemporaryDirectory(prefix="habitat-core-", dir=request["testRoot"]) as folder:
        sys.dont_write_bytecode = True
        # ifaddr's module initialization resolves libc with ctypes.find_library.
        # Linux may invoke ldconfig for that read-only loader lookup. Do it
        # before locking down scenario execution, not by permitting subprocesses
        # inside the guard. Importing does not call get_adapters or discover any
        # devices; Core/YAML execution below still runs entirely under the guard.
        import ifaddr  # noqa: F401
        blocked = install_guards(folder)
        with (nullcontext() if real_clock else time_machine.travel(case["start"], tick=False)) as frozen:
            import homeassistant  # installs the official validation backend
            rules = parse_source(request.get("yaml"), {e["id"] for e in request["project"]["entities"]})
            logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
            class ScenarioLoop(asyncio.SelectorEventLoop):
                def time(self):
                    # A per-scenario scheduler clock that only moves forward.
                    # Do not patch process-wide time.monotonic/perf_counter.
                    return time.time()
            with asyncio.Runner(loop_factory=asyncio.SelectorEventLoop if real_clock else ScenarioLoop) as runner:
                encoded = runner.run(run_case(request, rules, case, frozen, folder, blocked))
        print(encoded)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        traceback.print_exc(limit=12, file=sys.stderr)
        print(json.dumps({"error": str(error), "type": type(error).__name__}), file=sys.stderr)
        sys.exit(1)
