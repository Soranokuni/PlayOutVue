# Playout reliability verification

Run this against a non-production CasparCG channel after each playout change.

1. Load three video rows: an untrimmed clip, a virtual subclip with a non-zero
   in-point, and a following clip. Enable diagnostics.
2. Take the virtual subclip. Confirm the playback timeline records the same
   path/trim frame data as the generated `PLAY ... SEEK ... LENGTH` command,
   and visually confirm the first frame is not the parent-file start.
3. While the middle row is on air, take the row above, then the row below,
   including rapid consecutive takes. Confirm only the selected row is on air
   and no later row is auto-taken.
4. Preload a trimmed next item, edit its trim before EOF, then allow advance.
   Confirm diagnostics show an explicit corrected PLAY rather than stale AUTO.
5. Stop CasparCG during a trimmed item, reconnect, and verify the recovery
   dialog defaults to no on-air action. Choose Resume and confirm the seek is
   trim-relative; repeat and choose Stop.
6. Make the selected file unavailable and press Take. Confirm program output
   holds and Retry / Skip / Live controls appear. A 404/invalid trim flags the
   row; a connection failure does not.
7. Run a media-cache warmup while repeatedly taking the same set. Record
   dispatch latency and ensure the UI remains responsive.
