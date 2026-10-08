Our physiotherapy clinic in London books its patients on paper at the front
desk, and we keep double-booking people. We'd like a small booking tool.

**Clinic time.** The clinic keeps London time, and every time in the tool is
clinic time: what the clock in reception says. A time is written as the date
and the time of day on a 24-hour clock, every part with its leading zeros,
like 2026-11-03T09:45, and nothing else counts as a time. Seconds
(2026-11-03T09:45:00), a time zone or offset (2026-11-03T09:45Z,
2026-11-03T09:45+01:00), missing zeros (2026-11-3T9:45) and dates that don't
exist (2026-02-30T10:00) are all refused.

**Our clinicians.** The desk adds a clinician by typing their name. Spaces
before and after the name are dropped, and two clinicians may have the same
name; each gets their own reference when added. Anyone can see all the
clinicians, in the order they were added, each with their reference and name.
Adding one is refused with:

- "The clinician's name is missing" when the request has no name, or a name
  that isn't text;
- "The clinician's name can't be blank" when the name is empty or only
  spaces.

**Appointments.** An appointment is a quarter of an hour with one clinician
for one named patient. The desk books one by giving the clinician's
reference, the patient's name (kept without surrounding spaces) and the start
time, and each booking gets its own reference. The tool answers with the first
of these that applies, in this order:

1. "A booking needs a clinician, a patient and a start time": one of the
   three is missing, or isn't text.
2. "That clinician reference is malformed": it isn't the shape of a
   clinician's reference at all.
3. "The patient's name can't be blank".
4. "Write the start time like 2026-11-03T09:45": it isn't a time as described
   above.
5. "Appointments start on the hour, or at quarter past, half past or quarter
   to".
6. "Appointments start between 08:00 and 19:45".
7. "That time has already passed": it is earlier than the current clinic
   time. Booking for the current minute is fine.
8. "We have no clinician with that reference".
9. "That clinician is already booked at that time": they already have an
   appointment starting then.

So a malformed clinician reference with a blank patient name gets the
malformed-reference message, and a booking at 2026-11-03T09:50 with a
clinician we don't have gets the quarter-hour message.

The desk cancels an appointment by giving its reference, and it leaves the
list, freeing the clinician at that time; past appointments can be cancelled
too. Cancelling is refused with "Say which appointment to cancel" when the
reference is missing or isn't text, "That appointment reference is
malformed" when it isn't the shape of one, and "There is no booked
appointment with that reference" otherwise.

Anyone can see all booked appointments, past ones included, earliest start
first; appointments starting at the same time are listed in the order they
were booked. Each shows the appointment's reference, its start time written
as above, the clinician's reference and name, and the patient's name.

When the tool says no, nothing changes, and the person sees exactly the
message above, never a generic error.

**The nightly export.** Every night a scheduled job in the cloud sends the
whole appointment list to our records side. We haven't decided where it goes
yet; for now each run writes the list out where the job runs, so we can see
it happen. It is one row per appointment, in the list's order, with exactly
these fields in this order: appointment reference, start time, clinician
reference, clinician name, patient name.

**Where people use it.**

- **In a browser:** a web app that opens on the appointment list. From it,
  the desk adds and lists clinicians, and books, lists and cancels
  appointments.
- **At the front desk:** an installable desktop app with the same five
  actions.
- **From AI assistants:** assistants such as Claude get three tools,
  described to them as "List all clinicians", "List all appointments" and
  "Book an appointment". They cannot add clinicians or cancel.
- **The nightly export** above.

Nothing may be lost when an app restarts, and all of these places see the
same clinicians and appointments.
