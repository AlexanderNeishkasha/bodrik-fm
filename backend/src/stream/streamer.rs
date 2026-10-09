//! Synchronous authoritative playback transitions; callers own serialization and notification.

use crate::stream::{PlayerState, TrackEntry};
use std::{collections::VecDeque, time::Instant};

/// In-memory room playback state and ordered queue, independent of HTTP/media I/O.
pub struct Streamer {
    /// Tracks waiting to play.
    queue: VecDeque<TrackEntry>,
    /// Current track, retained while paused.
    current: Option<TrackEntry>,
    /// Whether monotonic time advances the position.
    is_playing: bool,
    /// Position at the last transition.
    position: f64,
    /// Monotonic start time of the current playing interval.
    started_at: Option<Instant>,
    /// Whether natural completion restarts the current track.
    repeat_one: bool,
}

impl Streamer {
    /// Create an empty, paused player with the persisted repeat setting.
    pub fn new(repeat_one: bool) -> Self {
        Self {
            queue: VecDeque::new(),
            current: None,
            is_playing: false,
            position: 0.0,
            started_at: None,
            repeat_one,
        }
    }

    /// Start a track at a finite position, preserving the waiting queue.
    ///
    /// # Errors
    /// Rejects non-finite positions without modifying playback; negative positions clamp to zero.
    pub fn play_track(&mut self, entry: TrackEntry, seek: f64) -> anyhow::Result<()> {
        let position = finite_position(seek)?;
        self.current = Some(entry);
        self.position = position;
        self.started_at = Some(Instant::now());
        self.is_playing = true;
        Ok(())
    }

    /// Append one resolved track to the queue.
    pub fn enqueue(&mut self, entry: TrackEntry) {
        self.queue.push_back(entry);
    }

    /// Append tracks in their authoritative library order.
    pub fn enqueue_many(&mut self, entries: Vec<TrackEntry>) {
        self.queue.extend(entries);
    }

    /// Put section remainders ahead of the existing queue without reversing them.
    pub fn prepend_many(&mut self, entries: Vec<TrackEntry>) {
        let mut next = VecDeque::from(entries);
        next.append(&mut self.queue);
        self.queue = next;
    }

    /// Insert at a requested position; positions at/past the end append.
    pub fn enqueue_at(&mut self, index: usize, entry: TrackEntry) {
        self.queue.insert(index.min(self.queue.len()), entry);
    }

    /// Move a queue entry; invalid or unchanged positions leave the queue untouched.
    pub fn reorder_queue(&mut self, from: usize, to: usize) -> bool {
        if from >= self.queue.len() || to >= self.queue.len() || from == to {
            return false;
        }
        let Some(entry) = self.queue.remove(from) else {
            return false;
        };
        self.queue.insert(to, entry);
        true
    }

    /// Remove an entry, returning no value for an out-of-range index.
    pub fn remove_at(&mut self, index: usize) -> Option<TrackEntry> {
        self.queue.remove(index)
    }

    /// Freeze the current monotonic position; pausing twice is a no-op.
    pub fn pause(&mut self) {
        if !self.is_playing {
            return;
        }
        self.position = self.current_position();
        self.is_playing = false;
        self.started_at = None;
    }

    /// Resume a paused track or start the queue head; an empty player stays silent.
    pub fn resume(&mut self) {
        if self.is_playing {
            return;
        }
        if self.current.is_none() {
            self.current = self.queue.pop_front();
            self.position = 0.0;
        }
        if self.current.is_some() {
            self.started_at = Some(Instant::now());
            self.is_playing = true;
        }
    }

    /// Seek a current track while preserving play/pause state.
    ///
    /// # Errors
    /// Rejects non-finite positions; finite negative positions clamp to zero.
    pub fn seek(&mut self, position: f64) -> anyhow::Result<()> {
        let position = finite_position(position)?;
        if self.current.is_none() {
            return Ok(());
        }
        self.position = position;
        if self.is_playing {
            self.started_at = Some(Instant::now());
        }
        Ok(())
    }

    /// Skip to the queue head, preserving paused state; an exhausted queue stops playback.
    pub fn skip(&mut self) {
        self.skip_at(Instant::now());
    }

    /// Commit a skip at the supplied transition time, preserving pause state.
    fn skip_at(&mut self, now: Instant) {
        self.current = self.queue.pop_front();
        self.position = 0.0;
        if self.current.is_none() {
            self.is_playing = false;
        }
        self.started_at = self.is_playing.then_some(now);
    }

    /// Advance/repeat only a playing track with a known finite nonnegative duration.
    pub fn advance_if_finished(&mut self) -> bool {
        self.advance_at(Instant::now())
    }

    /// Evaluate natural completion against an explicit monotonic time for deterministic tests.
    fn advance_at(&mut self, now: Instant) -> bool {
        if !self.is_playing {
            return false;
        }
        let Some(duration) = self
            .current
            .as_ref()
            .and_then(|track| track.duration)
            .filter(|value| value.is_finite() && *value >= 0.0)
        else {
            return false;
        };
        if self.position_at(now) < duration {
            return false;
        }
        if self.repeat_one {
            self.position = 0.0;
            self.started_at = Some(now);
        } else {
            self.skip_at(now);
        }
        true
    }

    /// Update every current/queued occurrence of a persisted track title.
    pub fn rename_track_by_id(&mut self, track_id: &str, to: &str) -> bool {
        let mut updated = false;
        if let Some(current) = &mut self.current
            && current.id == track_id
        {
            current.filename = to.to_owned();
            updated = true;
        }
        for entry in &mut self.queue {
            if entry.id == track_id {
                entry.filename = to.to_owned();
                updated = true;
            }
        }
        updated
    }

    /// Determine whether a canonical track ID is current, including while paused.
    pub fn is_current_id(&self, track_id: &str) -> bool {
        self.current
            .as_ref()
            .is_some_and(|current| current.id == track_id)
    }

    /// Remove all queued occurrences of a deleted track and return the number removed.
    pub fn remove_queued_by_id(&mut self, track_id: &str) -> usize {
        let before = self.queue.len();
        self.queue.retain(|entry| entry.id != track_id);
        before - self.queue.len()
    }

    /// Copy an authoritative snapshot while the caller holds the playback lock.
    pub fn snapshot(&self) -> PlayerState {
        PlayerState {
            is_playing: self.is_playing,
            position: self.current_position(),
            current: self.current.clone(),
            queue: self.queue.iter().cloned().collect(),
            repeat_one: self.repeat_one,
        }
    }

    /// Set natural-completion repeat policy without changing queue or position.
    pub fn set_repeat_one(&mut self, repeat_one: bool) {
        self.repeat_one = repeat_one;
    }

    /// Calculate elapsed monotonic time only for a playing interval.
    pub fn current_position(&self) -> f64 {
        self.position_at(Instant::now())
    }

    /// Calculate position at a controllable time without allowing clock underflow.
    fn position_at(&self, now: Instant) -> f64 {
        if self.is_playing
            && let Some(start) = self.started_at
        {
            return self.position + now.saturating_duration_since(start).as_secs_f64();
        }
        self.position
    }
}

/// Validate position arithmetic before altering any state.
///
/// # Errors
/// Returns an error for NaN or either infinity.
fn finite_position(position: f64) -> anyhow::Result<f64> {
    if !position.is_finite() {
        anyhow::bail!("invalid playback position");
    }
    Ok(position.max(0.0))
}

#[cfg(test)]
mod tests;
