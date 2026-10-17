# At scale: if one person and agents can build anything

Draft, 2026-10-17. A view, not a forecast. It takes [03](03-first-principles.md) to its end point and asks what Harness should be there.

## 1. What becomes cheap, and what becomes scarce

When building is close to free, value moves to whatever is still scarce:

| Cheap | Scarce |
|---|---|
| Writing code, tests, docs | **Knowing what is worth building**: intent, product sense |
| Planning and splitting work | **Knowing whether it worked**: real users, real devices, real conditions |
| Review against written rules | **Attention** of the people who decide and judge |
| Parallel effort, around the clock | **Trust**: people, brands, signatures, distribution |
| | **Verification infrastructure**: device labs, test environments, real-user loops |
| | **Compute and model capacity** at the moments it's needed |

Programming as typing goes the way of typesetting. Programming as **deciding what a system should do and proving it does** grows. Those were always the hard parts.

## 2. What programmers become

Today's programmer splits into roles that don't need typing:
- **Owners:** want something, write the brief, decide, judge. Product sense and taste, plus enough technical judgment to know what's hard and what's risky.
- **Verifiers:** design the bar, the tests, the device lab, the real-user loop. They decide what proof is enough. This is the most underrated skill of the next decade.
- **Domain experts:** knowledge outside the model, called by leads.
- **Builders of the machinery:** the people who make swarms run (capacity, CI, devices, safety). Infrastructure people.

Far fewer people are needed to produce a given amount of software. That isn't the same as fewer people building software: when software costs a hundredth as much, a hundred times more of it gets made. Every business, every device, every person gets software that today nobody would pay to write.

## 3. The organization becomes a portfolio of swarms

- **The unit is an owner with a swarm,** one direction pursued well.
- **A company is a few owners,** each with a swarm, coordinating at the level of goals and interfaces. The owners' agreements are the architecture.
- **Big efforts are swarms of swarms:** a brief at the top, domain leads below, each with its own owner where judgment matters.
- **Capacity is pooled and lent:** idle machines, subscriptions and devices flow to whichever swarm needs them, within an organization and possibly between people.

## 4. What Harness should be in that world

Not an IDE: the place where a person runs swarms.
1. **The floor:** see every worker, visit any desk, talk to yours.
2. **The owner's desk:** brief, decisions, try-it. Spending attention where it pays.
3. **Capacity:** machines, subscriptions, CI and devices as resources that are scheduled, budgeted and shared.
4. **Verification:** the ladder from unit tests to real users, with devices and environments as first-class resources.
5. **Trust between people:** invite, lend, watch, never type into what isn't yours, every action attributed.
6. **Memory:** briefs, decisions, observations and playbooks that outlive any agent's context.

The bet: **whoever makes one person's attention go furthest wins.** Models will keep improving and get cheaper, and every tool will have agents. What stays hard is turning a person's intent into working software they can trust, at the speed agents can now build.

## 5. Honest uncertainties
- **Will models plan and judge well enough** that a lead of leads runs for weeks without drift? The pilot ran for days.
- **Does quality hold at a thousand merged changes a day,** or does entropy win? See [07](07-risks.md).
- **Will platforms allow** subscriptions and accounts to be used by swarms at this intensity?
- **Society:** fewer programming jobs of today's kind, more of other kinds. The transition is the hard part, and it isn't ours to wave away.
