// SPDX-License-Identifier: GPL-2.0-only
/* Exercise the actual patched callbacks with adversarial display events. */
#include <stdio.h>
#include <string.h>
#include "../src/session-lock.c"

struct server server;
static unsigned acknowledgements;

void
wlr_session_lock_v1_send_locked(struct wlr_session_lock_v1 *lock)
{
	assert(lock);
	++acknowledgements;
}

struct fixture {
	struct session_lock_manager manager;
	struct wlr_session_lock_v1 lock;
	struct wlr_output displays[2];
	struct output outputs[2];
	struct session_lock_output locks[2];
};

static void
setup(struct fixture *f)
{
	memset(f, 0, sizeof(*f));
	acknowledgements = 0;
	f->manager.lock = &f->lock;
	f->manager.locked = true;
	f->manager.ack_pending = true;
	wl_list_init(&f->manager.lock_outputs);
	for (unsigned i = 0; i < 2; ++i) {
		f->displays[i].enabled = true;
		f->outputs[i].wlr_output = &f->displays[i];
		f->locks[i].output = &f->outputs[i];
		f->locks[i].manager = &f->manager;
		wl_list_insert(&f->manager.lock_outputs, &f->locks[i].link);
	}
}

static void
commit(struct fixture *f, unsigned index, uint32_t sequence, uint32_t fields)
{
	struct wlr_output_state state = { .committed = fields };
	f->displays[index].commit_seq = sequence;
	struct wlr_output_event_commit event = {
		.output = &f->displays[index], .state = &state,
	};
	handle_output_commit(&f->locks[index].commit, &event);
}

static void
present(struct fixture *f, unsigned index, uint32_t sequence, bool displayed)
{
	struct wlr_output_event_present event = {
		.output = &f->displays[index], .commit_seq = sequence, .presented = displayed,
	};
	handle_output_present(&f->locks[index].present, &event);
}

int
main(void)
{
	struct fixture f;
	setup(&f);
	send_locked_when_presented(&f.manager);
	assert(acknowledgements == 0);
	/* A property-only commit and a stale scanout cannot establish coverage. */
	commit(&f, 0, 10, WLR_OUTPUT_STATE_DAMAGE);
	present(&f, 0, 10, true);
	assert(!f.locks[0].locked_frame_presented && acknowledgements == 0);
	commit(&f, 0, 11, WLR_OUTPUT_STATE_BUFFER);
	present(&f, 0, 10, true);
	assert(!f.locks[0].locked_frame_presented);
	present(&f, 0, 11, false);
	assert(!f.locks[0].locked_frame_presented);
	present(&f, 0, 11, true);
	assert(f.locks[0].locked_frame_presented && acknowledgements == 0);
	/* Every enabled display must present its own protected frame. */
	commit(&f, 1, 22, WLR_OUTPUT_STATE_BUFFER);
	present(&f, 1, 21, true);
	assert(acknowledgements == 0);
	present(&f, 1, 22, true);
	assert(acknowledgements == 1 && !f.manager.ack_pending);
	present(&f, 1, 22, true);
	send_locked_when_presented(&f.manager);
	assert(acknowledgements == 1);

	/* A display that is actually disabled must not strand the lock. */
	setup(&f);
	commit(&f, 0, 1, WLR_OUTPUT_STATE_BUFFER);
	present(&f, 0, 1, true);
	f.displays[1].enabled = false;
	commit(&f, 1, 2, WLR_OUTPUT_STATE_ENABLED);
	assert(acknowledgements == 1);

	/* Re-enabling an output invalidates any previous coverage. */
	setup(&f);
	f.locks[1].locked_frame_presented = true;
	commit(&f, 1, 5, WLR_OUTPUT_STATE_ENABLED | WLR_OUTPUT_STATE_BUFFER);
	assert(!f.locks[1].locked_frame_presented);
	commit(&f, 0, 6, WLR_OUTPUT_STATE_BUFFER);
	present(&f, 0, 6, true);
	assert(acknowledgements == 0);
	present(&f, 1, 5, true);
	assert(acknowledgements == 1);

	/* A late presentation from before a power change is no longer proof
	 * that the newly enabled output displays a protected frame. */
	setup(&f);
	commit(&f, 1, 5, WLR_OUTPUT_STATE_BUFFER);
	f.displays[1].enabled = false;
	commit(&f, 1, 6, WLR_OUTPUT_STATE_ENABLED);
	f.displays[1].enabled = true;
	commit(&f, 1, 7, WLR_OUTPUT_STATE_ENABLED);
	present(&f, 1, 5, true);
	assert(!f.locks[1].locked_frame_presented);
	commit(&f, 0, 8, WLR_OUTPUT_STATE_BUFFER);
	present(&f, 0, 8, true);
	assert(acknowledgements == 0);
	commit(&f, 1, 9, WLR_OUTPUT_STATE_BUFFER);
	present(&f, 1, 9, true);
	assert(acknowledgements == 1);

	/* Equality remains correct across the 32-bit commit sequence wrap. */
	setup(&f);
	f.displays[1].enabled = false;
	commit(&f, 0, 0, WLR_OUTPUT_STATE_BUFFER);
	present(&f, 0, UINT32_MAX, true);
	assert(acknowledgements == 0);
	present(&f, 0, 0, true);
	assert(acknowledgements == 1);

	/* Late events after the lock client disappears cannot acknowledge it. */
	setup(&f);
	commit(&f, 0, 1, WLR_OUTPUT_STATE_BUFFER);
	f.manager.lock = NULL;
	f.displays[1].enabled = false;
	present(&f, 0, 1, true);
	assert(acknowledgements == 0 && f.manager.locked);

	puts("Lock presentation: two displays, stale/failed frames, power changes, sequence wrap and client loss passed");
	return 0;
}
