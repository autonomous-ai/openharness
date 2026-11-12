#!/usr/bin/env python3
"""area-worth.py: is a lampOS builder faster, or held less, in an area it has worked in?

Read-only. Talks to GitHub only through `gh api` and git, caches every response under
area-worth-data/, logs every API request to area-worth-data/requests.log and refuses to pass
its request budgets (120 GraphQL, 300 REST). Run with `python3 -I` (the data folder is untrusted).

    python3 -I area-worth.py probe          # GraphQL, 1 request: totals and every label with its counts
    python3 -I area-worth.py pulls          # REST, 52 requests: every pull request, oldest first, 100 a page
    python3 -I area-worth.py sizes 10 75    # GraphQL, 9: lines changed of the landed ones opened 20-25 Oct
    python3 -I area-worth.py reads 45 32    # GraphQL, 41: size, ready events, comments of those opened 26 Oct on
    python3 -I area-worth.py more-reads     # GraphQL, 1: the comments past the 60th of the four that have them
    python3 -I area-worth.py claims 12      # GraphQL, 10: when each task issue was labelled status:taken
    python3 -I area-worth.py files          # no network: the files each pull request changed, from the clone
    python3 -I area-worth.py analyze        # no network: every number in README.md
    python3 -I area-worth.py selfcheck      # no network: how often the tests cry wolf when nothing is there

The clone `files` reads was made once, by hand, with no API request (commits and trees only, 21 MB):

    git init --bare area-worth-data/lampOS.git && cd area-worth-data/lampOS.git
    git remote add origin https://github.com/autonomous-ai/lampOS.git
    git config remote.origin.promisor true; git config remote.origin.partialclonefilter blob:none
    git config extensions.partialClone origin
    git fetch --filter=blob:none --no-tags origin '+refs/heads/lamp-voice:refs/heads/lamp-voice' \
        '+refs/heads/main:refs/heads/main' \
        '+refs/heads/first/voice-cascade-gemini:refs/heads/first/voice-cascade-gemini' \
        '+refs/pull/*/head:refs/pull/*/head'
    git remote set-url origin /nonexistent/no-lazy-fetch          # so no later command can fetch a blob
    git ls-remote --heads https://github.com/autonomous-ai/lampOS.git > ../remote-heads.txt
    git ls-tree refs/heads/lamp-voice lampOS/builders/ | awk '{print $3}' > ../role-file-oids.txt
    git -c fetch.negotiationAlgorithm=noop fetch https://github.com/autonomous-ai/lampOS.git --no-tags \
        --no-write-fetch-head --filter=blob:none --stdin < ../role-file-oids.txt   # the 35 role files only
    (each role file was then written to ../role-files/<name>.md with `git cat-file -p`)

Also in the request log: two GraphQL pages of 100 pull requests with sizes and timelines that answered
HTTP 502 after 11 s (so the list came from REST), one test `sizes` request of 100 and one test `reads`
request of 20, and two REST calls for the repository's size (the first answered HTTP 503).
"""
import datetime
import glob
import json
import math
import os
import random
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "area-worth-data")
LEDGER = os.path.join(DATA, "requests.log")
OWNER, NAME = "autonomous-ai", "lampOS"
BUDGET = {"graphql": 120, "rest": 300}


def requests_made(kind):
    if not os.path.exists(LEDGER):
        return 0
    with open(LEDGER) as f:
        return sum(1 for line in f if line.split("\t")[1:2] == [kind])


def ask(kind, cache_name, cmd, timeout=90):
    """One request through `gh api`, cached on disk by name. Returns the parsed response."""
    path = os.path.join(DATA, cache_name + ".json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    if requests_made(kind) >= BUDGET[kind]:
        raise SystemExit("%s budget of %d requests reached; not asking." % (kind, BUDGET[kind]))
    started = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        status, out, err = proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        status, out, err = -1, "", "timeout"
    took = time.time() - started
    ok = status == 0 and out.strip()[:1] in ("{", "[") and '"errors"' not in out[:200]
    with open(LEDGER, "a") as f:
        f.write("%s\t%s\t%s\t%s\t%.1fs\t%d bytes\n" % (
            time.strftime("%Y-%m-%dT%H:%M:%S"), kind, cache_name, "ok" if ok else "FAILED", took, len(out)))
    if not ok:
        with open(os.path.join(DATA, cache_name + ".failed.txt"), "w") as f:
            f.write(out[:5000] + "\n--- stderr ---\n" + err[:5000])
        raise SystemExit("request %s failed (status %s): %s" % (cache_name, status, (err or out)[:400]))
    with open(path, "w") as f:
        f.write(out)
    return json.loads(out)


def gql(cache_name, query):
    return ask("graphql", cache_name, ["gh", "api", "graphql", "-f", "query=" + query])


# The twelve newest pull requests ride along once, to see what a train, a verdict and a file path look like.
PROBE = """
{
  rateLimit { cost remaining resetAt }
  repository(owner: "%s", name: "%s") {
    defaultBranchRef { name }
    pullRequests { totalCount }
    issues { totalCount }
    labels(first: 100, orderBy: {field: NAME, direction: ASC}) {
      totalCount
      nodes { name description pullRequests { totalCount } issues { totalCount } }
    }
    recent: pullRequests(last: 12) {
      nodes {
        number title state isDraft createdAt closedAt mergedAt additions deletions changedFiles
        headRefName baseRefName body
        labels(first: 20) { nodes { name } }
        files(first: 30) { totalCount nodes { path additions deletions } }
        comments(first: 20) { totalCount nodes { createdAt body } }
        reviews(first: 10) { totalCount nodes { state createdAt body } }
        timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT], first: 6) {
          nodes { __typename ... on ReadyForReviewEvent { createdAt } ... on ConvertToDraftEvent { createdAt } }
        }
      }
    }
  }
}
""" % (OWNER, NAME)


def probe():
    data = gql("probe-1", PROBE)["data"]
    repo = data["repository"]
    print("rate:", data["rateLimit"])
    print("default branch:", repo["defaultBranchRef"]["name"])
    print("pull requests:", repo["pullRequests"]["totalCount"], "issues:", repo["issues"]["totalCount"])
    print("labels:", repo["labels"]["totalCount"])
    for label in repo["labels"]["nodes"]:
        print("  %-28s prs=%-5d issues=%-5d %s" % (
            label["name"], label["pullRequests"]["totalCount"], label["issues"]["totalCount"],
            (label["description"] or "")[:70]))


# The list of pull requests comes from REST: a GraphQL page of 100 with sizes and timelines answered HTTP 502
# twice (11 s each). The jq filter drops the account and repository objects, so no login is kept on disk.
PULLS_JQ = ("[.[] | {number, title, state, draft, created_at, closed_at, merged_at, merge_commit_sha, "
            "head_ref: .head.ref, head_sha: .head.sha, base_ref: .base.ref, base_sha: .base.sha, "
            "labels: [.labels[].name], body}]")


def pulls(max_pages):
    """Every pull request, oldest first (new ones only ever extend the last page)."""
    page, asked = 0, 0
    while True:
        page += 1
        name = "pulls-%03d" % page
        cached = os.path.exists(os.path.join(DATA, name + ".json"))
        if not cached and asked >= max_pages:
            print("stopping before page %d (asked %d this run)" % (page, asked))
            return
        started = time.time()
        rows = ask("rest", name, [
            "gh", "api", "repos/%s/%s/pulls?state=all&sort=created&direction=asc&per_page=100&page=%d" % (
                OWNER, NAME, page), "--jq", PULLS_JQ])
        asked += 0 if cached else 1
        if not cached and rows:
            print("%s: %d PRs #%d..#%d created %s..%s, %.1fs" % (
                name, len(rows), rows[0]["number"], rows[-1]["number"], rows[0]["created_at"][:10],
                rows[-1]["created_at"][:10], time.time() - started))
        if len(rows) < 100:
            print("pulls complete: %d pages, last page holds %d" % (page, len(rows)))
            return


# ---------------------------------------------------------------------------------------------------------
# The record: which pull requests are trains, which landed and when, and whose they are.

TRAIN = re.compile(r"^first/train-(nc-)?\d+$")       # the bot's train branches (and the no-crates lane's)
ROWS = re.compile(r"^first/build-rows")              # the generated hourly "build rows" pull requests
SWARM_START = "2026-10-14"                           # the first pull request onto lamp-voice
GMT7 = datetime.timezone(datetime.timedelta(hours=7))


def when(text):
    if not text:
        return None
    return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)


def load_pulls():
    rows = []
    for path in sorted(glob.glob(os.path.join(DATA, "pulls-*.json"))):
        with open(path) as f:
            rows += json.load(f)
    return {row["number"]: row for row in rows}


def train_numbers_in_title(train):
    match = re.search(r"train[^:]*:(.*)$", train["title"])
    return [int(n) for n in re.findall(r"#?(\d{3,5})\b", match.group(1))] if match else []


def landings(pulls):
    """pull request number -> (when its merged train merged, the train's number). A train that names another
    train (774 on 773) lands that train's pull requests too."""
    trains = {n: p for n, p in pulls.items() if TRAIN.match(p["head_ref"])}
    landed = {}

    def carry(train, at, via, depth):
        for number in train_numbers_in_title(train):
            if number in trains:
                if number != train["number"] and depth < 3:
                    carry(trains[number], at, via, depth + 1)
            elif number not in landed or at < landed[number][0]:
                landed[number] = (at, via)

    for train in trains.values():
        if train["merged_at"]:
            carry(train, when(train["merged_at"]), train["number"], 0)
    return landed


def builder_of(pull):
    """The `builder:` label (the one that matches the branch when there are two), else the branch's first part."""
    labels = [label[len("builder:"):] for label in pull["labels"] if label.startswith("builder:")]
    prefix = pull["head_ref"].split("/")[0].lower() if "/" in pull["head_ref"] else None
    if labels:
        return prefix if prefix in labels else labels[0]
    return prefix


def builder_pulls(pulls):
    """Every pull request of the Swarm that is a builder's own: not a train, not generated rows, not onto main."""
    return {n: p for n, p in pulls.items()
            if p["created_at"] >= SWARM_START and p["base_ref"] != "main"
            and not TRAIN.match(p["head_ref"]) and not ROWS.match(p["head_ref"])}


def finished(pulls):
    """number -> (landed at, how) for builder pull requests that were merged or carried by a merged train."""
    landed = landings(pulls)
    out = {}
    for number, pull in builder_pulls(pulls).items():
        if pull["merged_at"]:
            out[number] = (when(pull["merged_at"]), "direct" if pull["base_ref"] == "lamp-voice" else "other-base")
        elif number in landed and pull["state"] == "closed":
            out[number] = (landed[number][0], "train")
    return out


# Two windows, by the day a pull request was opened (GMT+7). The question's: 20 Oct to 10 Nov. The marker era
# inside it: from 26 Oct, when 98-100% of landed pull requests carry READ-OK / HOLD markers and all but 34 land
# by train. Cycle time is read over the first, HOLDs over the second. Experience is counted from 14 Oct.
QUESTION_FROM = datetime.datetime(2026, 10, 20, tzinfo=GMT7)
OUTCOME_FROM = datetime.datetime(2026, 10, 26, tzinfo=GMT7)
OUTCOME_TO = datetime.datetime(2026, 11, 11, tzinfo=GMT7)
SIZE_FIELDS = "number additions deletions changedFiles"


def aliased(numbers, fields):
    body = "\n".join("    p%d: pullRequest(number: %d) { %s }" % (n, n, fields) for n in numbers)
    return ('{\n  rateLimit { cost remaining }\n  repository(owner: "%s", name: "%s") {\n%s\n  }\n}'
            % (OWNER, NAME, body))


def sizes(max_requests, per_request):
    """Lines and files changed, as GitHub counts them, for the landed pull requests opened 20 to 25 Oct
    (the later ones get theirs with `reads`). 75 a request: 100 took 8.5 s, near GitHub's 10 s limit."""
    pulls = load_pulls()
    done = finished(pulls)
    numbers = sorted(n for n, (at, how) in done.items()
                     if how != "other-base" and QUESTION_FROM <= when(pulls[n]["created_at"]) < OUTCOME_FROM)
    asked = 0
    for index in range(0, len(numbers), per_request):
        chunk = numbers[index:index + per_request]
        name = "sizes-%05d-%05d" % (chunk[0], chunk[-1])
        cached = os.path.exists(os.path.join(DATA, name + ".json"))
        if not cached and asked >= max_requests:
            print("stopping at %s (asked %d this run); %d left" % (name, asked, len(numbers) - index))
            return
        started = time.time()
        data = gql(name, aliased(chunk, SIZE_FIELDS))["data"]
        if not cached:
            asked += 1
            print("%s: %d pull requests, %.1fs, rate %s" % (name, len(chunk), time.time() - started, data["rateLimit"]))
    print("sizes complete: %d pull requests" % len(numbers))


def load_sizes():
    """number -> (lines changed, files changed) from `sizes` (and the one early test request of 100)."""
    out = {}
    for path in sorted(glob.glob(os.path.join(DATA, "sizes-*.json"))):
        with open(path) as f:
            for value in json.load(f)["data"]["repository"].values():
                out[value["number"]] = (value["additions"] + value["deletions"], value["changedFiles"])
    return out


def outcome_numbers(pulls):
    done = finished(pulls)
    return sorted(n for n, (at, how) in done.items()
                  if how != "other-base" and OUTCOME_FROM <= when(pulls[n]["created_at"]) < OUTCOME_TO)


READ_FIELDS = """number additions deletions changedFiles
      timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT], first: 8) {
        nodes { __typename ... on ReadyForReviewEvent { createdAt } ... on ConvertToDraftEvent { createdAt } } }
      comments(first: 60) { totalCount pageInfo { hasNextPage endCursor } nodes { createdAt body } }
      reviews(first: 10) { totalCount nodes { createdAt state body } }"""


def reads(max_requests, per_request):
    """Size, ready events and every comment of the outcome pull requests, newest first."""
    pulls = load_pulls()
    numbers = sorted(outcome_numbers(pulls), reverse=True)
    asked = 0
    for index in range(0, len(numbers), per_request):
        chunk = numbers[index:index + per_request]
        name = "reads-%05d-%05d" % (chunk[-1], chunk[0])
        cached = os.path.exists(os.path.join(DATA, name + ".json"))
        if not cached and asked >= max_requests:
            print("stopping at %s (asked %d this run); %d pull requests left" % (name, asked, len(numbers) - index))
            return
        started = time.time()
        data = gql(name, aliased(chunk, READ_FIELDS))["data"]
        if not cached:
            asked += 1
            print("%s: %d pull requests, %.1fs, rate %s" % (name, len(chunk), time.time() - started, data["rateLimit"]))
    print("reads complete: %d pull requests" % len(numbers))


# ---------------------------------------------------------------------------------------------------------
# Files changed, from a blobless clone (area-worth-data/lampOS.git: lamp-voice, main, first/voice-cascade-gemini
# and every refs/pull/N/head; commits and trees only). No API request.

REPO = os.path.join(DATA, "lampOS.git")
BRANCHES = ["refs/heads/lamp-voice", "refs/heads/first/voice-cascade-gemini", "refs/heads/main"]
HIDDEN_BUILDERS = {"eighth", "nine", "ten", "blue"}     # the four whose accounts, and so pull requests, are hidden


def git(*args):
    proc = subprocess.run(["git", "-C", REPO] + list(args), capture_output=True, text=True)
    return proc.returncode, proc.stdout.strip()


def changed(head, base):
    """The files between the fork point of head from base and head, as GitHub's three-dot diff lists them."""
    code, fork = git("merge-base", head, base)
    if code != 0 or fork == head:
        return None, None
    code, out = git("diff", "--name-only", "--no-renames", fork, head)
    return (fork, out.splitlines()) if code == 0 else (None, None)


def files():
    """Write files.json: the files each builder pull request changed, and for the hidden ones whose they are,
    about when they were opened and whether they landed."""
    pulls = load_pulls()
    landed_by_train = landings(pulls)
    # every commit on the three branches: parents, author date, commit date, subject
    code, out = git("log", "--format=%H%x09%P%x09%aI%x09%cI%x09%s", *BRANCHES)
    history, same_commit, merge_of = {}, {}, {}
    for line in out.splitlines():
        oid, parents, authored, committed, subject = line.split("\t", 4)
        history[oid] = (parents.split(), committed)
        same_commit.setdefault((authored, subject), oid)
        for parent in parents.split()[1:]:
            merge_of[parent] = oid
    code, out = git("for-each-ref", "refs/pull",
                    "--format=%(refname)%09%(objectname)%09%(authordate:iso-strict)%09%(contents:subject)")
    heads = {}
    for line in out.splitlines():
        ref, oid, authored, subject = line.split("\t", 3)
        heads[int(ref.split("/")[2])] = (oid, authored, subject)
    branch_of = {}
    with open(os.path.join(DATA, "remote-heads.txt")) as f:       # `git ls-remote --heads`, saved once
        for line in f:
            oid, ref = line.split()
            branch_of.setdefault(oid, ref[len("refs/heads/"):])

    visible, unknown = {}, 0
    for number, pull in sorted(builder_pulls(pulls).items()):
        head, merge = pull["head_sha"], pull["merge_commit_sha"]
        tip = BRANCHES[1] if pull["base_ref"] == "first/voice-cascade-gemini" else BRANCHES[0]
        fork, paths = None, None
        if pull["merged_at"] and merge:
            code, line = git("rev-list", "--parents", "-n", "1", merge)
            parents = line.split()[1:] if code == 0 else []
            if parents and merge != head:
                fork, paths = changed(head, parents[0])
            if paths is None:
                fork, paths = changed(head, pull["base_sha"])
        elif pull["base_ref"] in ("lamp-voice", "first/voice-cascade-gemini"):
            fork, paths = changed(head, tip)
        else:                                                      # stacked on another builder's branch
            fork, paths = changed(head, pull["base_sha"])
            if paths is None:
                fork, paths = changed(head, tip)
        if paths is None:
            unknown += 1
        visible[number] = {"fork": fork, "files": paths}

    # The hidden pull requests: no title, time or state from the API. Builder from the branch that still points
    # at the head; opened about when the nearest lower visible number was; landed if a merged train names it, or
    # its head is in the history, or a commit there has its author date and subject (a rebase or squash).
    numbers = sorted(pulls)
    claimed = set()
    for number, pull in pulls.items():
        if number in heads and (number in landed_by_train or pull["merged_at"]):
            claimed.add(same_commit.get((heads[number][1], heads[number][2])))
    hidden = {}
    for number in sorted(n for n in heads if n not in pulls):
        head, authored, subject = heads[number]
        branch = branch_of.get(head, "")
        builder = branch.split("/")[0].lower() if "/" in branch else None
        if builder not in HIDDEN_BUILDERS:
            continue
        lower = [n for n in numbers if n < number]
        opened = pulls[lower[-1]]["created_at"] if lower else None
        landed_at, how = None, None
        twin = same_commit.get((authored, subject))
        if number in landed_by_train:
            landed_at, how = landed_by_train[number][0].strftime("%Y-%m-%dT%H:%M:%SZ"), "train"
        elif head in history:
            via = merge_of.get(head, head)
            landed_at, how = history[via][1], "in-history"
        elif twin and twin not in claimed:
            landed_at, how = history[twin][1], "same-commit"
            claimed.add(twin)
        if head in history and head in merge_of:
            fork, paths = changed(head, history[merge_of[head]][0][0])
        else:
            fork, paths = changed(head, BRANCHES[0])
        hidden[number] = {"builder": builder, "opened": opened, "landed_at": landed_at, "how": how,
                          "fork": fork, "files": paths}
    with open(os.path.join(DATA, "files.json"), "w") as f:
        json.dump({"visible": visible, "hidden": hidden}, f)
    print("pull request heads fetched: %d; with no listing: %d" % (len(heads), sum(1 for n in heads if n not in pulls)))
    print("visible builder pull requests: %d, file list unknown for %d" % (len(visible), unknown))
    # The two git signs, tried on the visible closed pull requests opened before 26 Oct, whose fate is known.
    done, signs = finished(pulls), {"landed": [0, 0], "closed without landing": [0, 0]}
    for number, pull in builder_pulls(pulls).items():
        if pull["state"] == "closed" and when(pull["created_at"]) < OUTCOME_FROM:
            head, authored, subject = heads[number]
            fate = signs["landed" if number in done else "closed without landing"]
            fate[0] += head in history or (authored, subject) in same_commit
            fate[1] += 1
    print("in the history, or a commit there with the same author date and subject: %s" % "; ".join(
        "%d of %d %s" % (found, total, fate) for fate, (found, total) in signs.items()))
    print("hidden pull requests of %s: %d, landed %d (%s), file list unknown for %d" % (
        sorted(HIDDEN_BUILDERS), len(hidden), sum(1 for h in hidden.values() if h["landed_at"]),
        ", ".join("%s %d" % (k, sum(1 for h in hidden.values() if h["how"] == k))
                  for k in ("train", "in-history", "same-commit")),
        sum(1 for h in hidden.values() if h["files"] is None)))


def load_reads():
    """number -> what `reads` fetched, with the comments past the 60th added when `more-reads` has run."""
    out = {}
    for path in sorted(glob.glob(os.path.join(DATA, "reads-*.json"))):
        with open(path) as f:
            for value in json.load(f)["data"]["repository"].values():
                out[value["number"]] = value
    more = os.path.join(DATA, "more-reads.json")
    if os.path.exists(more):
        with open(more) as f:
            for value in json.load(f)["data"]["repository"].values():
                out[value["number"]]["comments"]["nodes"] += value["comments"]["nodes"]
                out[value["number"]]["comments"]["pageInfo"] = value["comments"]["pageInfo"]
    return out


def more_reads():
    over = {n: v for n, v in load_reads().items() if v["comments"]["pageInfo"]["hasNextPage"]}
    if not over:
        print("no pull request has more comments to fetch")
        return
    body = "\n".join(
        '    p%d: pullRequest(number: %d) { number comments(first: 100, after: "%s") '
        "{ totalCount pageInfo { hasNextPage endCursor } nodes { createdAt body } } }"
        % (n, n, v["comments"]["pageInfo"]["endCursor"]) for n, v in sorted(over.items()))
    data = gql("more-reads", '{\n  repository(owner: "%s", name: "%s") {\n%s\n  }\n}' % (OWNER, NAME, body))
    for value in data["data"]["repository"].values():
        print(value["number"], "more comments:", len(value["comments"]["nodes"]),
              "still more:", value["comments"]["pageInfo"]["hasNextPage"])


CLAIMS = """
{
  rateLimit { cost remaining }
  repository(owner: "%s", name: "%s") {
    issues(first: 50%s, labels: ["status:taken"], orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number createdAt closedAt
        labels(first: 15) { nodes { name } }
        timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT], first: 40) {
          nodes { __typename ... on LabeledEvent { createdAt label { name } }
                  ... on UnlabeledEvent { createdAt label { name } } }
        }
      }
    }
  }
}
"""


def claims(max_requests):
    """Every issue that carries status:taken, with its label events: the claim is the first time it was added."""
    cursor, page, asked = None, 0, 0
    while True:
        page += 1
        name = "claims-%02d" % page
        cached = os.path.exists(os.path.join(DATA, name + ".json"))
        if not cached and asked >= max_requests:
            print("stopping before page %d (asked %d this run)" % (page, asked))
            return
        started = time.time()
        after = ', after: "%s"' % cursor if cursor else ""
        data = gql(name, CLAIMS % (OWNER, NAME, after))["data"]
        issues = data["repository"]["issues"]
        if not cached:
            asked += 1
            print("%s: %d issues of %d, %.1fs, rate %s" % (
                name, len(issues["nodes"]), issues["totalCount"], time.time() - started, data["rateLimit"]))
        if not issues["pageInfo"]["hasNextPage"]:
            print("claims complete: %d pages" % page)
            return
        cursor = issues["pageInfo"]["endCursor"]


def load_claims():
    """issue number -> (when status:taken was first added, the issue's builder: labels)."""
    out = {}
    for path in sorted(glob.glob(os.path.join(DATA, "claims-*.json"))):
        with open(path) as f:
            for issue in json.load(f)["data"]["repository"]["issues"]["nodes"]:
                taken = sorted(when(node["createdAt"]) for node in issue["timelineItems"]["nodes"]
                               if node.get("__typename") == "LabeledEvent" and node["label"]["name"] == "status:taken")
                if taken:
                    names = [label["name"] for label in issue["labels"]["nodes"]]
                    out[issue["number"]] = (taken[0], [n[len("builder:"):] for n in names if n.startswith("builder:")])
    return out


# ---------------------------------------------------------------------------------------------------------
# The table: one row for every finished piece of work (the experience ledger), with outcomes where they were read.

SIDE = ("docs", "lampOS-root")        # documents and lockfiles ride along with code; they name the area only alone


def stem(name):
    return name.rsplit(".", 1)[0] if "." in name[1:] else name


def area_of_path(path):
    """Coarse: the crate, or the top-level folder (lampOS/<folder> inside the product tree)."""
    parts = path.split("/")
    if parts[0] == "lampOS":
        if len(parts) >= 4 and parts[1] == "crates":
            return "crate/" + parts[2]
        if len(parts) >= 3:
            return "docs" if parts[1] == "docs" else "lampOS/" + parts[1]
        return "lampOS-root"
    return parts[0] if len(parts) >= 2 else "root"


def module_of_path(path):
    """Fine: the module inside the crate (the first name under src/), or the next folder or file down."""
    parts = path.split("/")
    if parts[0] == "lampOS":
        if len(parts) >= 4 and parts[1] == "crates":
            rest = parts[3:]
            return "crate/%s/%s" % (parts[2], stem(rest[1] if rest[0] == "src" and len(rest) > 1 else rest[0]))
        if len(parts) >= 3:
            if parts[1] == "docs":
                name = stem(parts[3]) if parts[2] == "vi" and len(parts) > 3 else stem(parts[2])
                return "docs/" + re.sub(r"_vi$", "", name)
            return "lampOS/%s/%s" % (parts[1], stem(parts[2]))
        return "lampOS-root"
    if parts[0] == ".github" and len(parts) >= 3:
        return ".github/" + stem(parts[-1])
    return "%s/%s" % (parts[0], stem(parts[1])) if len(parts) >= 2 else "root"


def is_side(key):
    return key in SIDE or key.startswith("docs/")


def main_of(paths, of, code_first=True):
    """The area holding most of the changed files. Code first: documents and root files count only when alone."""
    counts = {}
    for path in paths:
        counts[of(path)] = counts.get(of(path), 0) + 1
    if code_first and any(not is_side(key) for key in counts):
        counts = {key: n for key, n in counts.items() if not is_side(key)}
    if not counts:
        return None
    top = max(counts.values())
    return sorted(key for key, n in counts.items() if n == top)[0]


MARK = r"(READ-OK|HOLD)\b"
COMMIT = r"([0-9a-f]{7,40})\b"
VERDICT_PLAIN = re.compile(r"\b" + MARK + r"[\s:`*]*" + COMMIT)                       # READ-OK <commit>
VERDICT_CLAUSE = re.compile(r"(?:^|[,:;—–-]\s*)[*`]*" + MARK +               # "Name, HOLD on <commit>"
                            r"[*`]*(?:\s+(?:on|at)\b|\s+#\d+|[\s:`*])*" + COMMIT)
VERDICT_AT_START = re.compile(r"^[\s>*`#-]*" + MARK + r"[\s:`*]*" + COMMIT)


def verdict_of(body):
    """READ-OK or HOLD when the comment's first line holds the marker and then a commit, or one of its next
    three lines starts with it (a reader's name line first). `HOLD train N` and prose about someone's HOLD
    ("my HOLD on <commit> is fixed") are not verdicts."""
    lines = (body or "").strip().split("\n")
    if lines[0].startswith("Train bot"):
        return None
    match = VERDICT_PLAIN.search(lines[0]) or VERDICT_CLAUSE.search(lines[0])
    if not match:
        for line in lines[1:4]:
            match = VERDICT_AT_START.search(line)
            if match:
                break
    return match.group(1) if match else None


def minutes(later, earlier):
    return (later - earlier).total_seconds() / 60.0


def known_builders():
    with open(os.path.join(DATA, "probe-1.json")) as f:
        labels = json.load(f)["data"]["repository"]["labels"]["nodes"]
    return {label["name"][len("builder:"):] for label in labels if label["name"].startswith("builder:")}


def phase_of(opened):
    local = opened.astimezone(GMT7)
    if local < QUESTION_FROM:
        return "before 20 Oct"
    if local < OUTCOME_FROM:
        return "20-25 Oct"
    if local < datetime.datetime(2026, 11, 1, 18, tzinfo=GMT7):
        return "A"                                    # first builder as PM, its own crew working
    if local < datetime.datetime(2026, 11, 4, 11, tzinfo=GMT7):
        return "B"                                    # its crew away
    if local < datetime.datetime(2026, 11, 9, 9, 34, tzinfo=GMT7):
        return "C"                                    # the Swarm PM
    return "D"                                        # first builder as PM again


def experience(mine, at, row):
    """What a builder had landed before `at`: anywhere, in this row's area, in its module."""
    before = [e for e in mine if e["landed"] < at and e["number"] != row.get("number")]
    out = {"prior_any": len(before)}
    for key in ("area", "area_literal", "module"):
        out["prior_" + key] = sum(1 for e in before if e[key] == row[key])
    return out


def place(row, paths):
    row["files"] = paths or []
    row["area"] = main_of(row["files"], area_of_path)
    row["area_literal"] = main_of(row["files"], area_of_path, code_first=False)
    row["module"] = main_of(row["files"], module_of_path)
    return row


def build_table():
    """One row for every finished piece of work since 14 Oct (the experience ledger). Rows opened 20 Oct to
    10 Nov carry size and cycle time ("studied"); those from 26 Oct also carry what their comments say ("marked")."""
    pulls = load_pulls()
    reads = load_reads()
    lines_of = load_sizes()
    with open(os.path.join(DATA, "files.json")) as f:
        changed_files = json.load(f)
    visible = {int(n): v for n, v in changed_files["visible"].items()}
    hidden = {int(n): v for n, v in changed_files["hidden"].items()}

    rows = []
    for number, (landed_at, how) in finished(pulls).items():
        pull = pulls[number]
        rows.append(place({"number": number, "builder": builder_of(pull) or "?", "opened": when(pull["created_at"]),
                           "landed": landed_at, "how": how, "hidden": False, "body": pull["body"] or ""},
                          visible[number]["files"]))
    for number, item in hidden.items():
        if item["landed_at"] and item["opened"]:
            landed_at = datetime.datetime.fromisoformat(item["landed_at"].replace("Z", "+00:00"))
            rows.append(place({"number": number, "builder": item["builder"], "opened": when(item["opened"]),
                               "landed": landed_at, "how": "hidden-" + item["how"], "hidden": True, "body": ""},
                              item["files"]))
    rows.sort(key=lambda r: (r["opened"], r["number"]))

    ledger = {}
    for row in rows:
        ledger.setdefault(row["builder"], []).append(row)
    for mine in ledger.values():
        for index, row in enumerate(mine):
            row.update(experience(mine, row["opened"], row))
            row["overall_order"] = index + 1
            row["order_area"] = 1 + sum(1 for e in mine[:index] if e["area"] == row["area"])
            row["order_module"] = 1 + sum(1 for e in mine[:index] if e["module"] == row["module"])

    for row in rows:
        on_branch = not row["hidden"] and row["how"] != "other-base"
        row["phase"] = phase_of(row["opened"])
        row["day"] = row["opened"].astimezone(GMT7).strftime("%m-%d")
        row["cycle"] = max(1.0, minutes(row["landed"], row["opened"]))
        row["stacked"] = bool(re.search(r"(?i)\bstacked on\b", row["body"][:600]))
        row["studied"] = on_branch and QUESTION_FROM <= row["opened"] < OUTCOME_TO
        row["marked"] = row["studied"] and row["opened"] >= OUTCOME_FROM
        row["early"] = on_branch and row["opened"] < OUTCOME_TO      # 14 Oct on, for one check with size by files
        if row["studied"] and not row["marked"]:
            row["lines"] = lines_of[row["number"]][0]
        if not row["marked"]:
            continue
        read = reads[row["number"]]
        row["lines"] = read["additions"] + read["deletions"]
        events = sorted((when(node["createdAt"]), node["__typename"]) for node in read["timelineItems"]["nodes"])
        row["draft"] = bool(events) and events[0][1] == "ReadyForReviewEvent"
        row["ready"] = events[0][0] if row["draft"] else row["opened"]
        verdicts = []
        notes = [(node["createdAt"], node["body"]) for node in read["comments"]["nodes"] + read["reviews"]["nodes"]]
        for created, body in notes:
            verdict = verdict_of(body)
            if verdict and when(created) <= row["landed"]:
                verdicts.append((when(created), verdict))
        verdicts.sort()
        oks = [at for at, verdict in verdicts if verdict == "READ-OK"]
        row["verdicts"] = len(verdicts)
        row["holds"] = sum(1 for _, verdict in verdicts if verdict == "HOLD")
        row["held"] = 1 if row["holds"] else 0
        row["cycle_ready"] = max(1.0, minutes(row["landed"], row["ready"]))
        first, last_ok = (verdicts[0][0] if verdicts else None), (oks[-1] if oks else None)
        row["to_first_verdict"] = minutes(first, row["ready"]) if first and first > row["ready"] else None
        row["review_span"] = minutes(last_ok, first) if last_ok and last_ok >= first else None
        row["after_last_ok"] = minutes(row["landed"], last_ok) if last_ok else None
    return rows, ledger


def claim_rows(ledger):
    """One row per task issue that was labelled status:taken and then answered by a pull request of the builder
    the issue is labelled for: the minutes from the claim to the first pull request naming the issue near its top."""
    pulls = load_pulls()
    taken = load_claims()
    with open(os.path.join(DATA, "files.json")) as f:
        visible = {int(n): v for n, v in json.load(f)["visible"].items()}
    done = finished(pulls)
    everyone = builder_pulls(pulls)
    names = re.compile(r"(?i)\b(?:part of|for|fixes|closes|resolves|follow-up (?:of|to))\s+#(\d+)")
    answering = {}
    for number, pull in everyone.items():
        for match in names.finditer((pull["body"] or "")[:400]):
            if int(match.group(1)) in taken:
                answering.setdefault(int(match.group(1)), []).append(number)
    rows = []
    dropped = {"first pull request opened before the claim": 0, "by a builder the issue is not labelled for": 0}
    for issue, numbers in answering.items():
        claim, labelled_for = taken[issue]
        numbers.sort(key=lambda n: everyone[n]["created_at"])
        first = everyone[numbers[0]]
        opened, builder = when(first["created_at"]), builder_of(first)
        if opened < claim:
            dropped["first pull request opened before the claim"] += 1
            continue
        if builder not in labelled_for:
            dropped["by a builder the issue is not labelled for"] += 1
            continue
        row = place({"issue": issue, "builder": builder, "claim": claim, "opened": opened,
                     "minutes": minutes(opened, claim)}, visible[numbers[0]]["files"])
        row.update(experience(ledger.get(builder, []), claim, row))
        landings_of_it = [done[n][0] for n in numbers
                          if n in done and done[n][1] != "other-base" and builder_of(everyone[n]) == builder]
        row["to_landed"] = minutes(min(landings_of_it), claim) if landings_of_it else None
        row["phase"] = phase_of(opened)
        row["week"] = ("14-19 Oct" if row["phase"] == "before 20 Oct" else "20-25 Oct" if row["phase"] == "20-25 Oct"
                       else "26 Oct-1 Nov" if row["phase"] == "A" else "2-10 Nov")
        rows.append(row)
    return rows, len(taken), len(answering), dropped


def attempt_rows(ledger):
    """Every builder pull request opened 20 Oct to 10 Nov that is closed: landed, or closed without landing."""
    pulls = load_pulls()
    with open(os.path.join(DATA, "files.json")) as f:
        visible = {int(n): v for n, v in json.load(f)["visible"].items()}
    done = finished(pulls)
    rows = []
    for number, pull in builder_pulls(pulls).items():
        opened = when(pull["created_at"])
        if not (QUESTION_FROM <= opened < OUTCOME_TO) or pull["state"] != "closed":
            continue
        if pull["base_ref"] not in ("lamp-voice",) and number not in done:
            continue
        if number in done and done[number][1] == "other-base":
            continue
        builder = builder_of(pull) or "?"
        row = place({"number": number, "builder": builder, "opened": opened, "unlanded": 0 if number in done else 1},
                    visible[number]["files"])
        row.update(experience(ledger.get(builder, []), opened, row))
        row["phase"], row["day"] = phase_of(opened), opened.astimezone(GMT7).strftime("%m-%d")
        rows.append(row)
    return rows


# ---------------------------------------------------------------------------------------------------------
# Statistics: medians, a least-squares fit with fixed effects and builder-clustered errors, a permutation test
# that shuffles the exposure inside builder x phase, and matched pairs.

def median(values):
    values = sorted(values)
    if not values:
        return float("nan")
    middle = len(values) // 2
    return values[middle] if len(values) % 2 else (values[middle - 1] + values[middle]) / 2.0


def t_critical(df):
    """The two-sided 95% point of Student's t (Cornish-Fisher; 2.042 at 30 degrees of freedom)."""
    z = 1.959964
    return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2)


def dummies(values, least=1):
    """One column per level but the commonest; levels with fewer than `least` rows share one column."""
    counts = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    lumped = [value if counts[value] >= least else "(other)" for value in values]
    levels = sorted(set(lumped), key=lambda v: (-sum(1 for x in lumped if x == v), str(v)))
    return [[1.0 if value == level else 0.0 for value in lumped] for level in levels[1:]]


def fit(np, rows, outcome, exposures, controls, effects):
    """Least squares of outcome on the exposure columns, the control columns and fixed effects.
    Returns per exposure: coefficient, clustered standard error, 95% interval; and what a permutation needs."""
    y = np.array([outcome(r) for r in rows], dtype=float)
    columns = [[1.0] * len(rows)]
    columns += [[float(e(r)) for r in rows] for e in exposures]
    columns += [[float(c(r)) for r in rows] for c in controls]
    for effect, least in effects:
        columns += dummies([effect(r) for r in rows], least)
    X = np.array(columns).T
    inverse = np.linalg.pinv(X.T @ X)
    beta = inverse @ X.T @ y
    residual = y - X @ beta
    groups = {}
    for index, row in enumerate(rows):
        groups.setdefault(row["builder"], []).append(index)
    meat = np.zeros((X.shape[1], X.shape[1]))
    for members in groups.values():
        score = X[members].T @ residual[members]
        meat += np.outer(score, score)
    n, k, g = X.shape[0], np.linalg.matrix_rank(X), len(groups)
    variance = inverse @ meat @ inverse * (g / (g - 1.0)) * ((n - 1.0) / (n - k))
    critical = t_critical(g - 1)
    out = []
    for index in range(len(exposures)):
        b, se = beta[1 + index], float(np.sqrt(max(0.0, variance[1 + index, 1 + index])))
        out.append({"b": float(b), "se": se, "lo": float(b - critical * se), "hi": float(b + critical * se)})
    return out, X, y, len(groups)


def permutation_p(np, rows, X, y, column, strata, rounds=5000, seed=20261111):
    """Two-sided p for one exposure column (Freedman-Lane): fit without the exposure, shuffle that fit's
    residuals inside each stratum, and see how often the exposure's coefficient is as large as observed.
    The exposure and its tie to builder, day and area stay as they are; only the unexplained part moves."""
    rng = np.random.default_rng(seed)
    others = np.delete(X, column, axis=1)
    project = np.linalg.pinv(others)
    x_left = X[:, column] - others @ (project @ X[:, column])
    y_left = y - others @ (project @ y)
    scale = float(x_left @ x_left)
    observed = float(x_left @ y_left) / scale
    groups = {}
    for index, row in enumerate(rows):
        groups.setdefault(strata(row), []).append(index)
    members = [np.array(m) for m in groups.values() if len(m) > 1]
    extreme = 0
    for _ in range(rounds):
        shuffled = y_left.copy()
        for m in members:
            shuffled[m] = y_left[rng.permutation(m)]
        if abs(float(x_left @ shuffled) / scale) >= abs(observed) - 1e-12:
            extreme += 1
    return (1 + extreme) / (1.0 + rounds)


def binomial_two_sided(k, n):
    """Exact two-sided p for k of n at one half."""
    from math import comb
    if n == 0:
        return 1.0
    tail = sum(comb(n, i) for i in range(0, min(k, n - k) + 1)) / 2.0 ** n
    return min(1.0, 2 * tail)


# ---------------------------------------------------------------------------------------------------------
# The analysis. Everything printed here is in README.md.

BANDS = [(0, 50, "1-50"), (51, 200, "51-200"), (201, 500, "201-500"), (501, 1500, "501-1500"),
         (1501, 10 ** 9, "over 1500")]


def band_of(lines):
    return next(index for index, (low, high, _) in enumerate(BANDS) if low <= lines <= high)


def order_group(order):
    return ("1st" if order == 1 else "2nd" if order == 2 else "3rd-5th" if order <= 5 else
            "6th-10th" if order <= 10 else "11th-20th" if order <= 20 else "21st on")


def clock(m):
    return "-" if m != m else ("%.0f min" % m if m < 120 else "%.1f h" % (m / 60.0))


def share(rows, key):
    return "%.0f%%" % (100.0 * sum(r[key] for r in rows) / len(rows)) if rows else "-"


def is_new(key):
    return lambda r: 1.0 if r["prior_" + key] == 0 and r["prior_any"] > 0 else 0.0


def first_ever(r):
    return 1.0 if r["prior_any"] == 0 else 0.0


def log_size(r):
    return math.log(r["lines"] + 1)


def log_files(r):
    return math.log(len(r["files"]) + 1)


def tenure(r):
    return math.log(1 + r["prior_any"])


def strata(r):
    return (r["builder"], r["phase"])


def compare(np, rows, outcome, exposure, size=log_size, area_key="area", with_area=True, time_key="day",
            extra=(), rounds=5000):
    """The exposure's coefficient with size (and its square), tenure, and builder, day and area fixed effects."""
    exposures = [exposure] + ([first_ever] if any(first_ever(r) for r in rows) else []) + list(extra)
    effects = [(lambda r: r["builder"], 1), (lambda r: r[time_key], 1)]
    if with_area:
        effects.append((lambda r: r[area_key], 8))
    results, X, y, builders = fit(np, rows, outcome, exposures, [size, lambda r: size(r) ** 2, tenure], effects)
    out = results[0]
    out["p"] = permutation_p(np, rows, X, y, 1, strata, rounds)
    out["exposed"], out["n"], out["builders"] = sum(1 for r in rows if exposure(r) > 0), len(rows), builders
    out["all"] = results
    return out


def p_text(p):
    return "<0.01" if p < 0.005 else "%.2f" % p


def as_ratio(result):
    return "x%.2f | %.2f to %.2f | %s | %d of %d" % (
        math.exp(result["b"]), math.exp(result["lo"]), math.exp(result["hi"]), p_text(result["p"]),
        result["exposed"], result["n"])


def as_points(result):
    return "%+.1f pts | %+.1f to %+.1f | %s | %d of %d" % (
        100 * result["b"], 100 * result["lo"], 100 * result["hi"], p_text(result["p"]), result["exposed"], result["n"])


def pairs(rows, new, familiar, window):
    """Each new-area row with the same builder's familiar-area row of the same size band that is nearest in the
    builder's own order of landed work (at most `window` apart), each familiar row used once."""
    used, out = set(), []
    for one in sorted((r for r in rows if new(r)), key=lambda r: (r["opened"], r["number"])):
        candidates = [r for r in rows if r["builder"] == one["builder"] and familiar(r) and r["number"] not in used
                      and band_of(r["lines"]) == band_of(one["lines"])
                      and abs(r["overall_order"] - one["overall_order"]) <= window]
        if candidates:
            other = min(candidates, key=lambda r: (abs(r["overall_order"] - one["overall_order"]),
                                                   abs(log_size(r) - log_size(one))))
            used.add(other["number"])
            out.append((one, other))
    return out


def pair_line(name, matched, wanted):
    rng = random.Random(7)
    logs = [math.log(a["cycle"]) - math.log(b["cycle"]) for a, b in matched]
    mean = sum(logs) / len(logs)
    flips = sum(1 for _ in range(10000)
                if abs(sum(x if rng.random() < 0.5 else -x for x in logs) / len(logs)) >= abs(mean) - 1e-12)
    boots = sorted(sum(logs[rng.randrange(len(logs))] for _ in logs) / len(logs) for _ in range(4000))
    both = [(a, b) for a, b in matched if a["marked"] and b["marked"]]
    only_new = sum(1 for a, b in both if a["held"] and not b["held"])
    only_old = sum(1 for a, b in both if b["held"] and not a["held"])
    print("| %s | %d of %d | %d | %.0f / %.0f | %s / %s | x%.2f (%.2f to %.2f), p %s | %.0f%% "
          "| %s / %s of %d; %d against %d, p %s |" % (
        name, len(matched), wanted, len({a["builder"] for a, b in matched}),
        median(a["lines"] for a, b in matched), median(b["lines"] for a, b in matched),
        clock(median(a["cycle"] for a, b in matched)), clock(median(b["cycle"] for a, b in matched)),
        math.exp(mean), math.exp(boots[100]), math.exp(boots[3899]), p_text((1 + flips) / 10001.0),
        100.0 * sum(1 for x in logs if x > 0) / len(logs),
        share([a for a, b in both], "held"), share([b for a, b in both], "held"), len(both),
        only_new, only_old, p_text(binomial_two_sided(only_new, only_new + only_old))))


class Study:
    """What every section reads: the ledger, and the two samples of the builders who have a `builder:` label."""

    def __init__(self):
        import numpy
        self.np = numpy
        self.rows, self.ledger = build_table()
        self.pulls = load_pulls()
        self.labelled = known_builders()
        self.studied = [r for r in self.rows if r["studied"] and r["builder"] in self.labelled]   # 20 Oct-10 Nov
        self.marked = [r for r in self.rows if r["marked"] and r["builder"] in self.labelled]     # 26 Oct-10 Nov


def log_cycle(r):
    return math.log(r["cycle"])


def held(r):
    return float(r["held"])


def log_of(key):
    return lambda r: math.log(r[key] + 1)


FIXED = [(lambda r: r["builder"], 1), (lambda r: r["day"], 1), (lambda r: r["area"], 8)]
SIZE = [log_size, lambda r: log_size(r) ** 2]


def print_counts(study):
    rows, pulls, studied, marked = study.rows, study.pulls, study.studied, study.marked
    done = finished(pulls)
    trains = [q for q in pulls.values() if TRAIN.match(q["head_ref"])]
    print("## Counts")
    print("pull requests listed: %d; trains: %d (%d merged); builder pull requests since 14 Oct: %d" % (
        len(pulls), len(trains), sum(1 for q in trains if q["merged_at"]), len(builder_pulls(pulls))))
    print("finished and visible: %d (by train %d, merged onto lamp-voice %d, merged onto another branch %d)" % (
        len(done), sum(1 for v in done.values() if v[1] == "train"), sum(1 for v in done.values() if v[1] == "direct"),
        sum(1 for v in done.values() if v[1] == "other-base")))
    print("hidden but recovered into the ledger: %d; ledger rows: %d; builders in the ledger: %d" % (
        sum(1 for r in rows if r["hidden"]), len(rows), len(study.ledger)))
    print("opened 20 Oct-10 Nov and landed on lamp-voice: %d; by the %d builders with a builder: label: %d" % (
        sum(1 for r in rows if r["studied"]), len({r["builder"] for r in studied}), len(studied)))
    print("of those opened 26 Oct on: %d; by %d labelled builders: %d; with a verdict marker: %d; "
          "verdicts: %d (%d HOLD)" % (
              sum(1 for r in rows if r["marked"]), len({r["builder"] for r in marked}), len(marked),
              sum(1 for r in marked if r["verdicts"]), sum(r["verdicts"] for r in marked),
              sum(r["holds"] for r in marked)))
    print("pull requests with a HOLD, 26 Oct on, labelled builders: %d of %d (%s)" % (
        sum(r["held"] for r in marked), len(marked), share(marked, "held")))
    fates = {"landed": 0, "closed": 0, "open": 0}
    for number, pull in builder_pulls(pulls).items():
        if pull["base_ref"] == "lamp-voice" and QUESTION_FROM <= when(pull["created_at"]) < OUTCOME_TO:
            fates["landed" if number in done else pull["state"]] += 1
    print("builder pull requests onto lamp-voice opened 20 Oct-10 Nov: landed %(landed)d, closed without landing "
          "%(closed)d, still open %(open)d" % fates)
    manual = [r for r in rows if r["marked"] and r["phase"] in ("A", "B")]
    print("as the earlier study counts: landed of those opened 20-25 Oct: %d; hidden ones carried by merged "
          "trains: %d; manual phase (26 Oct-4 Nov 11:00): %d landed, median cycle %s, %d opened as drafts, "
          "%d with a HOLD of %d with a verdict, size bands %s" % (
              sum(1 for r in rows if r["studied"] and r["phase"] == "20-25 Oct"),
              sum(1 for n in landings(pulls) if n not in pulls), len(manual), clock(median(r["cycle"] for r in manual)),
              sum(r["draft"] for r in manual), sum(r["held"] for r in manual), sum(1 for r in manual if r["verdicts"]),
              "/".join(str(sum(1 for r in manual if band_of(r["lines"]) == index)) for index in range(len(BANDS)))))
    with open(os.path.join(DATA, "files.json")) as f:
        from_git = {int(n): len(v["files"] or []) for n, v in json.load(f)["visible"].items()}
    by_github = {n: files for n, (_, files) in load_sizes().items()}
    by_github.update({n: read["changedFiles"] for n, read in load_reads().items()})
    print("files changed, git against GitHub's changedFiles: equal on %d of %d" % (
        sum(1 for n, files in by_github.items() if from_git[n] == files), len(by_github)))
    with open(os.path.join(DATA, "probe-1.json")) as f:
        labels = json.load(f)["data"]["repository"]["labels"]
    on_pulls = sorted(((l["pullRequests"]["totalCount"], l["name"]) for l in labels["nodes"]
                       if l["pullRequests"]["totalCount"] and not l["name"].startswith("builder:")), reverse=True)
    print("labels: %d (%d builder: labels); labels on any pull request that are not builder: labels: %s" % (
        labels["totalCount"], sum(1 for l in labels["nodes"] if l["name"].startswith("builder:")),
        ", ".join("%s %d" % (name, count) for count, name in on_pulls)))
    mine = builder_pulls(pulls)
    plain = sum(1 for q in mine.values() if re.match(r"(?i)^lampos\s*:", q["title"]))
    print("builder pull requests whose title starts with just 'lampOS:': %d of %d; with no builder: label: %d" % (
        plain, len(mine), sum(1 for q in mine.values() if not any(l.startswith("builder:") for l in q["labels"]))))
    print("areas with landed work: %d; modules: %d; builder x area pairs: %d; builder x module pairs: %d" % (
        len({r["area"] for r in rows}), len({r["module"] for r in rows}),
        len({(r["builder"], r["area"]) for r in rows}), len({(r["builder"], r["module"]) for r in rows})))
    sizes_of_areas = sorted(((a, sum(1 for r in studied if r["area"] == a)) for a in {r["area"] for r in studied}),
                            key=lambda kv: (-kv[1], kv[0]))
    print("largest areas among the studied: " + ", ".join("%s %d" % (k, v) for k, v in sizes_of_areas[:8]))
    literal = sum(1 for r in studied if r["area"] != r["area_literal"])
    print("studied rows whose area changes when documents are counted like code: %d of %d" % (literal, len(studied)))
    for key in ("area", "module"):
        print("%s: first ever %d, new %d, familiar %d (studied); first ever %d, new %d, familiar %d (26 Oct on)" % (
            key, sum(1 for r in studied if first_ever(r)), sum(1 for r in studied if is_new(key)(r)),
            sum(1 for r in studied if r["prior_" + key] > 0), sum(1 for r in marked if first_ever(r)),
            sum(1 for r in marked if is_new(key)(r)), sum(1 for r in marked if r["prior_" + key] > 0)))


def print_by_order(study):
    print("\n## 1. By its order among the builder's landed pull requests in the area")
    for key, name in (("order_area", "area"), ("order_module", "module")):
        print("\n| order in the %s | PRs 20 Oct-10 Nov | builders | lines, median | opened to landed, median "
              "| PRs 26 Oct on | with a HOLD | ready to landed, median |" % name)
        print("|---|---|---|---|---|---|---|---|")
        for group in ("1st", "2nd", "3rd-5th", "6th-10th", "11th-20th", "21st on"):
            a = [r for r in study.studied if order_group(r[key]) == group]
            b = [r for r in study.marked if order_group(r[key]) == group]
            print("| %s | %d | %d | %.0f | %s | %d | %s | %s |" % (
                group, len(a), len({r["builder"] for r in a}), median(r["lines"] for r in a),
                clock(median(r["cycle"] for r in a)), len(b), share(b, "held"),
                clock(median(r["cycle_ready"] for r in b))))


def print_size_bands(study):
    studied, marked, new = study.studied, study.marked, is_new("area")
    print("\n## 1b. New against familiar inside each size band (area), builders with landed work elsewhere")
    print("\n| lines changed | new: PRs | familiar: PRs | new: opened to landed | familiar | new: PRs 26 Oct on "
          "| familiar | new: with a HOLD | familiar |")
    print("|---|---|---|---|---|---|---|---|---|")
    for index, (_, _, label) in enumerate(BANDS):
        a = [r for r in studied if band_of(r["lines"]) == index and new(r)]
        b = [r for r in studied if band_of(r["lines"]) == index and r["prior_area"] > 0]
        c = [r for r in marked if band_of(r["lines"]) == index and new(r)]
        d = [r for r in marked if band_of(r["lines"]) == index and r["prior_area"] > 0]
        print("| %s | %d | %d | %s | %s | %d | %d | %s | %s |" % (
            label, len(a), len(b), clock(median(r["cycle"] for r in a)), clock(median(r["cycle"] for r in b)),
            len(c), len(d), share(c, "held"), share(d, "held")))
    for name, group in (("first ever", [r for r in studied if first_ever(r)]),
                        ("new area", [r for r in studied if new(r)]),
                        ("familiar area", [r for r in studied if r["prior_area"] > 0])):
        later = [r for r in group if r["marked"]]
        print("%s: %d PRs, %d builders, median %.0f lines, opened to landed %s; 26 Oct on: %d PRs, HOLD %s, "
              "ready to landed %s" % (
                  name, len(group), len({r["builder"] for r in group}), median(r["lines"] for r in group),
                  clock(median(r["cycle"] for r in group)), len(later), share(later, "held"),
                  clock(median(r["cycle_ready"] for r in later))))


def print_adjusted(study):
    """New against familiar, by area and by module, for each measure. Returns the fits, for the last section."""
    np, studied, marked, new = study.np, study.studied, study.marked, is_new("area")
    print("\n## 2. Size, builder, day, area and tenure held equal: new against familiar")
    print("\n| measure | sample | area: new / familiar | 95% interval | p | new of all "
          "| module: new / familiar | 95% interval | p | new of all |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    primary = {}

    def line(name, sample_name, sample, outcome, form):
        primary[name] = (compare(np, sample, outcome, is_new("area")), compare(np, sample, outcome, is_new("module")))
        print("| %s | %s | %s | %s |" % (name, sample_name, form(primary[name][0]), form(primary[name][1])))

    def having(key):
        return [r for r in marked if r[key] is not None]

    line("opened to landed", "20 Oct-10 Nov", studied, log_cycle, as_ratio)
    line("opened to landed, marker era", "26 Oct-10 Nov", marked, log_cycle, as_ratio)
    line("ready to landed", "26 Oct-10 Nov", marked, lambda r: math.log(r["cycle_ready"]), as_ratio)
    line("ready to first verdict", "26 Oct-10 Nov", having("to_first_verdict"), log_of("to_first_verdict"), as_ratio)
    line("first verdict to last READ-OK", "26 Oct-10 Nov", having("review_span"), log_of("review_span"), as_ratio)
    line("last READ-OK to landed", "26 Oct-10 Nov", having("after_last_ok"), log_of("after_last_ok"), as_ratio)
    line("got a HOLD", "26 Oct-10 Nov", marked, held, as_points)
    attempts = [r for r in attempt_rows(study.ledger) if r["builder"] in study.labelled]
    unlanded = lambda r: float(r["unlanded"])
    print("| closed without landing (size by files) | 20 Oct-10 Nov | %s | %s |" % (
        as_points(compare(np, attempts, unlanded, is_new("area"), size=log_files)),
        as_points(compare(np, attempts, unlanded, is_new("module"), size=log_files))))
    print("closed pull requests 20 Oct-10 Nov by labelled builders: %d, closed without landing: %d (%s)" % (
        len(attempts), sum(r["unlanded"] for r in attempts), share(attempts, "unlanded")))
    part = having("after_last_ok")
    for name, group in (("new", [r for r in part if new(r)]), ("familiar", [r for r in part if r["prior_area"] > 0])):
        waits = sorted(r["after_last_ok"] for r in group)
        print("last READ-OK to landed, %s area: median %s, 90th percentile %s, over 3 h: %d of %d" % (
            name, clock(median(waits)), clock(waits[int(0.9 * len(waits))]), sum(1 for w in waits if w > 180),
            len(waits)))
    return primary


def print_other_choices(study):
    np, studied, marked, new = study.np, study.studied, study.marked, is_new("area")
    print("\n## 2b. The same comparison (area) under other choices")
    print("\n| choice | opened to landed: new / familiar | 95% interval | p | new of all | got a HOLD "
          "| 95% interval | p | new of all |")
    print("|---|---|---|---|---|---|---|---|---|")

    def check(name, cycle_rows, hold_rows, exposure=new, **options):
        print("| %s | %s | %s |" % (
            name, as_ratio(compare(np, cycle_rows, log_cycle, exposure, rounds=2000, **options)),
            as_points(compare(np, hold_rows, held, exposure, rounds=2000, **options))))

    def keep(rows, test):
        return [r for r in rows if test(r)]

    seen = lambda r: r["builder"] not in HIDDEN_BUILDERS
    check("as in the table above", studied, marked)
    check("without the four builders whose early pull requests are hidden", keep(studied, seen), keep(marked, seen))
    check("without pull requests stacked on another", keep(studied, lambda r: not r["stacked"]),
          keep(marked, lambda r: not r["stacked"]))
    check("no area fixed effect", studied, marked, with_area=False)
    check("area by most files, documents counted like code", studied, marked, exposure=is_new("area_literal"),
          area_key="area_literal")
    check("1st or 2nd landed in the area against 3rd or later", studied, marked,
          exposure=lambda r: 1.0 if r["order_area"] <= 2 and r["prior_any"] > 0 else 0.0)
    check("only builders with 20 or more landed", keep(studied, lambda r: r["prior_any"] >= 20),
          keep(marked, lambda r: r["prior_any"] >= 20))
    early = [r for r in study.rows if r["early"] and r["builder"] in study.labelled]
    print("| 14 Oct-10 Nov, size by files changed | %s | - | - | - | - |" % as_ratio(
        compare(np, early, log_cycle, new, size=log_files, rounds=2000)))
    # Builders drawn again with replacement, 1,000 times: a second look at the first row's interval.
    names = sorted({r["builder"] for r in studied})
    mine = {b: [r for r in studied if r["builder"] == b] for b in names}
    rng = np.random.default_rng(11)
    draws = []
    for _ in range(1000):
        sample = []
        for copy, index in enumerate(rng.choice(len(names), len(names), replace=True)):
            sample += [dict(r, builder="%s#%d" % (names[index], copy)) for r in mine[names[index]]]
        draws.append(fit(np, sample, log_cycle, [new, first_ever], SIZE + [tenure], FIXED)[0][0]["b"])
    draws.sort()
    print("builders resampled 1,000 times, opened to landed, new / familiar: x%.2f (%.2f to %.2f)" % (
        math.exp(median(draws)), math.exp(draws[25]), math.exp(draws[974])))


def print_pairs_and_tenure(study):
    np, studied, marked, new = study.np, study.studied, study.marked, is_new("area")
    print("\n## 3. Area against tenure: pairs inside one builder, same size band, next to each other in its own order")
    print("\n| new side / familiar side | pairs of new | builders | lines, median: new / familiar "
          "| opened to landed, median | geometric mean ratio (95%), sign-flip p | new slower "
          "| with a HOLD: new / familiar, pairs 26 Oct on; only-new against only-familiar |")
    print("|---|---|---|---|---|---|---|---|")
    for name, key, floor, window in (("area: none landed / 3 or more landed", "area", 3, 20),
                                     ("area: none landed / any landed", "area", 1, 10),
                                     ("module: none landed / 3 or more landed", "module", 3, 20),
                                     ("module: none landed / any landed", "module", 1, 10)):
        matched = pairs(studied, is_new(key), lambda r, key=key, floor=floor: r["prior_" + key] >= floor, window)
        pair_line(name, matched, sum(1 for r in studied if is_new(key)(r)))
    early_there = lambda r: r["order_area"] <= 2 and r["prior_any"] > 0
    pair_line("area: 1st or 2nd there / 3rd or later", pairs(studied, early_there, lambda r: r["order_area"] >= 3, 20),
              sum(1 for r in studied if early_there(r)))
    matched = pairs(studied, new, lambda r: r["prior_area"] >= 3, 20)
    print("pairs area none/3+: median distance in the builder's own order: %.0f" % median(
        abs(a["overall_order"] - b["overall_order"]) for a, b in matched))
    exposures = [lambda r: math.log2(1 + r["prior_any"]), first_ever, new]
    for name, sample, outcome, form in (("opened to landed", studied, log_cycle, as_ratio),
                                        ("got a HOLD", marked, held, as_points)):
        results, X, y, _ = fit(np, sample, outcome, exposures, SIZE, FIXED)
        for index, label in ((0, "each doubling of landed work anywhere"),
                             (1, "a builder's first landed pull request")):
            result = dict(results[index], p=permutation_p(np, sample, X, y, 1 + index, strata, 2000),
                          exposed=sum(1 for r in sample if exposures[index](r) > 0), n=len(sample))
            print("tenure, %s, %s: %s" % (name, label, form(result)))


def print_steps(study):
    np = study.np
    print("\n## 4. The allocator's steps: landed work in the area before this one was opened (against none)")
    print("\n| | 1 landed | 2 landed | 3 or more landed | each doubling of (1 + landed) |")
    print("|---|---|---|---|---|")
    print("| the allocator plans (time) | x0.85 | x0.70 | x0.60 | - |")
    for key in ("area", "module"):
        for name, sample, outcome, ratio in (("opened to landed", study.studied, log_cycle, True),
                                             ("got a HOLD", study.marked, held, False)):
            steps = [lambda r, key=key: 1.0 if r["prior_" + key] == 1 else 0.0,
                     lambda r, key=key: 1.0 if r["prior_" + key] == 2 else 0.0,
                     lambda r, key=key: 1.0 if r["prior_" + key] >= 3 else 0.0]
            results, _, _, _ = fit(np, sample, outcome, steps + [first_ever], SIZE + [tenure], FIXED)
            dose = compare(np, sample, outcome, lambda r, key=key: math.log2(1 + r["prior_" + key]), rounds=2000)
            cells = []
            for index in range(3):
                r, count = results[index], sum(1 for q in sample if steps[index](q))
                cells.append("x%.2f (%.2f to %.2f), %d PRs" % (
                    math.exp(r["b"]), math.exp(r["lo"]), math.exp(r["hi"]), count)
                    if ratio else "%+.1f pts (%+.1f to %+.1f), %d PRs" % (
                        100 * r["b"], 100 * r["lo"], 100 * r["hi"], count))
            cells.append("x%.3f (%.3f to %.3f), p %s" % (
                math.exp(dose["b"]), math.exp(dose["lo"]), math.exp(dose["hi"]), p_text(dose["p"]))
                if ratio else "%+.1f pts (%+.1f to %+.1f), p %s" % (
                    100 * dose["b"], 100 * dose["lo"], 100 * dose["hi"], p_text(dose["p"])))
            print("| %s, %s | %s |" % (key, name, " | ".join(cells)))


def print_claims(study):
    np, marked, new = study.np, study.marked, is_new("area")
    print("\n## 5. From the claim (status:taken) to the first pull request that names the issue")
    claimed, taken, answered, dropped = claim_rows(study.ledger)
    print("issues ever labelled status:taken: %d; named near the top of a builder pull request: %d; %s; usable: %d" % (
        taken, answered, "; ".join("%s: %d" % item for item in dropped.items()), len(claimed)))
    waits = sorted(r["minutes"] for r in claimed)
    print("claim to first pull request: median %s, 25th %s, 75th %s, 90th %s" % (
        clock(median(waits)), clock(waits[len(waits) // 4]), clock(waits[3 * len(waits) // 4]),
        clock(waits[int(0.9 * len(waits))])))
    by_files = (("1-2", lambda n: n <= 2), ("3-5", lambda n: 3 <= n <= 5), ("6-10", lambda n: 6 <= n <= 10),
                ("over 10", lambda n: n > 10))
    print("by files changed: " + "; ".join(
        "%s files: %d, median %s" % (label, sum(1 for r in claimed if test(len(r["files"]))),
                                     clock(median(r["minutes"] for r in claimed if test(len(r["files"])))))
        for label, test in by_files))
    print("\n| | claims | builders | files, median | claim to first PR: median | 25th to 75th | within 3 h "
          "| claim to first landing: median (claims) |")
    print("|---|---|---|---|---|---|---|---|")
    for name, group in (("a builder's first task", [r for r in claimed if first_ever(r)]),
                        ("new area", [r for r in claimed if new(r)]),
                        ("familiar area", [r for r in claimed if r["prior_area"] > 0]),
                        ("new module", [r for r in claimed if is_new("module")(r)]),
                        ("familiar module", [r for r in claimed if r["prior_module"] > 0])):
        waits = sorted(r["minutes"] for r in group)
        to_landed = [r["to_landed"] for r in group if r["to_landed"] is not None]
        print("| %s | %d | %d | %.0f | %s | %s to %s | %.0f%% | %s (%d) |" % (
            name, len(group), len({r["builder"] for r in group}), median(len(r["files"]) for r in group),
            clock(median(waits)), clock(waits[len(waits) // 4]), clock(waits[3 * len(waits) // 4]),
            100.0 * sum(1 for w in waits if w <= 180) / len(waits), clock(median(to_landed)), len(to_landed)))
    experienced = [r for r in claimed if r["prior_any"] > 0]
    for r in experienced:       # the builder's other claims not yet answered by a pull request when this was taken
        r["waiting"] = sum(1 for other in claimed if other is not r and other["builder"] == r["builder"]
                           and other["claim"] < r["claim"] < other["opened"])
    options = dict(size=log_files, with_area=False, time_key="week")
    for name, sample, outcome in (("claim to first pull request", experienced, log_of("minutes")),
                                  ("claim to first landing", [r for r in experienced if r["to_landed"] is not None],
                                   log_of("to_landed"))):
        for key in ("area", "module"):
            result = compare(np, sample, outcome, is_new(key), **options)
            print("%s, new %s / familiar: %s (%d builders)" % (name, key, as_ratio(result), result["builders"]))
    queue = compare(np, experienced, log_of("minutes"), new, extra=[log_of("waiting")], **options)
    mean_waiting = lambda test: (sum(r["waiting"] for r in experienced if test(r))
                                 / max(1, sum(1 for r in experienced if test(r))))
    print("with the builder's other open claims held equal: %s; open claims at the claim, mean: "
          "new %.2f, familiar %.2f" % (as_ratio(queue), mean_waiting(new), mean_waiting(lambda r: not new(r))))
    by_builder_and_week = [(lambda r: r["builder"], 1), (lambda r: r["week"], 1)]
    size_check = fit(np, experienced, log_of("minutes"), [log_files], [tenure], by_builder_and_week)[0][0]
    print("does it follow size? each 1%% more files: %+.2f%% (%.2f to %.2f)" % (
        size_check["b"], size_check["lo"], size_check["hi"]))
    # The other candidate, the gap since the builder's previous pull request, does not follow size: not used.
    opened_by = {}
    for pull in builder_pulls(study.pulls).values():
        opened_by.setdefault(builder_of(pull) or "?", []).append(when(pull["created_at"]))
    gaps = []
    for r in marked:
        times = sorted(opened_by[r["builder"]])
        index = times.index(r["opened"])
        if index > 0 and 5 <= minutes(times[index], times[index - 1]) <= 480:
            gaps.append(dict(r, gap=minutes(times[index], times[index - 1])))
    gap_check = fit(np, gaps, lambda r: math.log(r["gap"]), [log_size], [], FIXED[:2])[0][0]
    cycle_check = fit(np, marked, log_cycle, [log_size], [], FIXED[:2])[0][0]
    print("the gap since the builder's previous pull request (5 min to 8 h, %d PRs, median %s): each 1%% more lines: "
          "%+.3f%% (%.3f to %.3f); cycle time: %+.2f%% (%.2f to %.2f)" % (
              len(gaps), clock(median(r["gap"] for r in gaps)), gap_check["b"], gap_check["lo"], gap_check["hi"],
              cycle_check["b"], cycle_check["lo"], cycle_check["hi"]))


def owned_crates():
    """builder -> the crates its role file lists as its own (asides in brackets and "and in ..." left out)."""
    owned = {}
    paths = sorted(glob.glob(os.path.join(DATA, "role-files", "*.md")))
    for path in paths:
        with open(path) as f:
            text = f.read()
        section = re.search(r"## What it owns\n(.*?)(?=\n## )", text, re.S)
        crates = re.search(r"-\s*\**Crates?\**:?\**\s*(.*?)(?=\n- |\Z)", section.group(1) if section else "", re.S)
        listed = re.sub(r"\([^)]*\)", "", crates.group(1) if crates else "").split(", and ")[0]
        found = re.findall(r"`crates/([a-z0-9-]+)/?`", listed)
        if found and not re.match(r"\s*none", listed):
            owned[os.path.basename(path)[:-3]] = {"crate/" + name for name in found}
    return owned, len(paths) - 2                     # two of the files are templates


def print_own_area(study):
    np, marked = study.np, study.marked
    print("\n## 6. Own area: the crates a role file names, and where most of a builder's work has been")
    owned, read = owned_crates()
    print("role files read: %d; with crates of their own: %s" % (
        read, "; ".join("%s (%s)" % (b, ", ".join(sorted(c))) for b, c in sorted(owned.items()))))
    theirs = [r for r in marked if r["builder"] in owned]
    for name, group in (("in its own crates", [r for r in theirs if r["area"] in owned[r["builder"]]]),
                        ("elsewhere", [r for r in theirs if r["area"] not in owned[r["builder"]]])):
        print("those builders, %s: %d PRs, median %.0f lines, opened to landed %s, HOLD %s" % (
            name, len(group), median(r["lines"] for r in group), clock(median(r["cycle"] for r in group)),
            share(group, "held")))
    # Own area in practice: the share of the builder's landed work, before this one, that was in this area.
    home = lambda r: r["prior_area"] / float(r["prior_any"])
    seasoned_c = [r for r in study.studied if r["prior_any"] >= 10]
    seasoned_h = [r for r in marked if r["prior_any"] >= 10]
    away = lambda r: 1.0 if home(r) < 0.1 else 0.0
    between = lambda r: 1.0 if 0.1 <= home(r) < 0.5 else 0.0
    for name, sample, outcome, form in (("opened to landed", seasoned_c, log_cycle, as_ratio),
                                        ("got a HOLD", seasoned_h, held, as_points)):
        result = compare(np, sample, outcome, away, extra=[between], rounds=2000)
        print("%s, area with under a tenth of its landed work (%d PRs) against half or more (%d PRs): %s" % (
            name, sum(1 for r in sample if away(r)), sum(1 for r in sample if home(r) >= 0.5), form(result)))
    for name, key in (("ready to first verdict", "to_first_verdict"),
                      ("first verdict to last READ-OK", "review_span"), ("last READ-OK to landed", "after_last_ok")):
        part = [r for r in seasoned_h if r[key] is not None]
        print("  %s, under a tenth against half or more: %s" % (
            name, as_ratio(compare(np, part, log_of(key), away, extra=[between], rounds=2000))))
    for name, test in (("half or more", lambda r: home(r) >= 0.5), ("a tenth to half", lambda r: 0.1 <= home(r) < 0.5),
                       ("under a tenth", lambda r: home(r) < 0.1)):
        group_c, group_h = [r for r in seasoned_c if test(r)], [r for r in seasoned_h if test(r)]
        print("  %s: %d PRs, median %.0f lines, opened to landed %s; 26 Oct on %d PRs, HOLD %s" % (
            name, len(group_c), median(r["lines"] for r in group_c), clock(median(r["cycle"] for r in group_c)),
            len(group_h), share(group_h, "held")))


def print_smallest(primary):
    """What a test of this size finds four times in five: 2.8 standard errors."""
    print("\n## 7. The smallest difference these samples could have shown (80% power, 5% two-sided)")
    for name in ("opened to landed", "opened to landed, marker era", "ready to landed", "got a HOLD"):
        area, module = primary[name]
        if name == "got a HOLD":
            print("%s: area %.0f points, module %.0f points" % (name, 280 * area["se"], 280 * module["se"]))
        else:
            print("%s: area x%.2f, module x%.2f" % (name, math.exp(2.8 * area["se"]), math.exp(2.8 * module["se"])))
    with open(LEDGER) as f:
        asked = [line.split("\t") for line in f]
    for kind in ("graphql", "rest"):
        mine = [line for line in asked if line[1] == kind]
        print("%s requests: %d (%d failed)" % (kind, len(mine), sum(1 for line in mine if line[3] == "FAILED")))


def analyze():
    study = Study()
    print_counts(study)
    print_by_order(study)
    print_size_bands(study)
    primary = print_adjusted(study)
    print_other_choices(study)
    print_pairs_and_tenure(study)
    print_steps(study)
    print_claims(study)
    print_own_area(study)
    print_smallest(primary)


def selfcheck(runs=300):
    """The same pull requests and the same fit, with outcomes made up so that the exposure changes nothing:
    the fit's own prediction with the exposure set to zero, a shock per builder and day, and noise. A fair
    test says "different" in about 5% of such runs."""
    import numpy as np
    rows, _ = build_table()
    labelled = known_builders()
    studied = [r for r in rows if r["studied"] and r["builder"] in labelled]
    seasoned = [r for r in studied if r["prior_any"] >= 10]
    home = lambda r: r["prior_area"] / float(r["prior_any"])
    cases = (("new area against familiar", studied, [is_new("area"), first_ever]),
             ("under a tenth of its landed work against half or more", seasoned,
              [lambda r: 1.0 if home(r) < 0.1 else 0.0, lambda r: 1.0 if 0.1 <= home(r) < 0.5 else 0.0]))
    for name, sample, exposures in cases:
        controls = [log_size, lambda r: log_size(r) ** 2, tenure]
        effects = [(lambda r: r["builder"], 1), (lambda r: r["day"], 1), (lambda r: r["area"], 8)]
        _, X, y, builders = fit(np, sample, lambda r: math.log(r["cycle"]), exposures, controls, effects)
        beta = np.linalg.pinv(X.T @ X) @ X.T @ y
        spread = float((y - X @ beta).std())
        beta[1] = 0.0
        cells = sorted({(r["builder"], r["day"]) for r in sample})
        cell_of = [cells.index((r["builder"], r["day"])) for r in sample]
        shock, noise = 0.45, math.sqrt(spread ** 2 - 0.45 ** 2)
        rng = np.random.default_rng(5)
        by_interval = by_permutation = 0
        for run in range(runs):
            made = X @ beta + rng.normal(0, shock, len(cells))[cell_of] + rng.normal(0, noise, len(sample))
            value = {id(r): v for r, v in zip(sample, made)}
            results, X2, y2, _ = fit(np, sample, lambda r: value[id(r)], exposures, controls, effects)
            by_interval += abs(results[0]["b"]) > t_critical(builders - 1) * results[0]["se"]
            by_permutation += permutation_p(np, sample, X2, y2, 1, strata, rounds=300, seed=run) < 0.05
        print("%s: %d runs with no true difference (residual spread of log cycle %.2f): the 95%% interval "
              "excluded 1 in %.1f%%, the permutation test gave p < 0.05 in %.1f%%" % (
                  name, runs, spread, 100.0 * by_interval / runs, 100.0 * by_permutation / runs))


if __name__ == "__main__":
    os.makedirs(DATA, exist_ok=True)
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "probe":
        probe()
    elif command == "pulls":
        pulls(int(sys.argv[2]) if len(sys.argv) > 2 else 60)
    elif command == "reads":
        reads(int(sys.argv[2]) if len(sys.argv) > 2 else 1, int(sys.argv[3]) if len(sys.argv) > 3 else 20)
    elif command == "more-reads":
        more_reads()
    elif command == "analyze":
        analyze()
    elif command == "selfcheck":
        selfcheck()
    elif command == "claims":
        claims(int(sys.argv[2]) if len(sys.argv) > 2 else 1)
    elif command == "files":
        files()
    elif command == "sizes":
        sizes(int(sys.argv[2]) if len(sys.argv) > 2 else 1, int(sys.argv[3]) if len(sys.argv) > 3 else 75)
    else:
        raise SystemExit(__doc__)
