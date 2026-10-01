We are a small physiotherapy clinic and need a simple tool for booking our
clinicians' appointments.

**Clinicians.** Anyone at the front desk can add a clinician by giving their
name, and anyone can see the list of all clinicians. A clinician's name is
required: leading and trailing spaces don't count, so a name that is empty or
only spaces is refused with the message "Clinician name is required". The
name is kept without those surrounding spaces. Every clinician gets their own
identity when they are added, and two clinicians may share a name. A request
to add a clinician that has no name at all, or gives it as something other
than text, is refused with "Invalid add clinician input".

**Appointments.** Anyone can book an appointment by giving the clinician, the
patient's name and the time it starts, and anyone can see the list of all
booked appointments, each showing its clinician, the patient's name and its
start time, earliest first. Every appointment lasts a quarter of an hour and
starts on the quarter hour, written as a date and a time such as
"2026-11-03T09:45". The patient's name is required on the same terms as a
clinician's name: empty or only spaces is refused with "Patient name is
required", and it is kept without surrounding spaces. Every appointment gets
its own identity when it is booked.

Booking an appointment checks these in order, and the first that fails is the
answer:

1. The request gives the clinician, the patient's name and the start time,
   each as text; otherwise "Invalid book appointment input".
2. The clinician reference is a valid clinician identity; otherwise "Invalid
   clinician id".
3. The patient's name is not empty once trimmed; otherwise "Patient name is
   required".
4. The start time is a real date and time on the quarter hour; otherwise
   "Start time must be on the quarter hour".
5. The clinician exists; otherwise "Clinician not found".
6. The clinician has no other appointment starting at that time; otherwise
   "Clinician is already booked at that time".

So a malformed clinician reference together with a blank patient name is
answered "Invalid clinician id", and a start time of "2026-11-03T09:50" for
a clinician who doesn't exist is answered "Start time must be on the quarter
hour".

Anyone can cancel an appointment by giving it. A request that doesn't give
the appointment as text is refused with "Invalid cancel appointment input"; a
reference that is not a valid appointment identity with "Invalid appointment
id"; and one that names no booked appointment with "Appointment not found". A
cancelled appointment leaves the list, and its clinician is free at that time
again.

A refused request changes nothing, and whoever made it gets the reason in
exactly the words above rather than a generic error.

**Export.** A scheduled job, run in the cloud every night, exports the whole
list of booked appointments to our records side. Where exactly the export ends
up isn't decided yet; for now it is enough that each run writes the full list
out where the job runs, so we can see it happen.

**Where people use it.**

- **In a browser:** a web app whose first screen lists the booked
  appointments, earliest first. Through the web app, people can add and list
  clinicians, and book, list and cancel appointments.
- **On the desktop:** an installable desktop app for the front desk with the
  same five actions as the web app.
- **From AI assistants:** assistants such as Claude can list the clinicians,
  list the appointments and book an appointment, as three tools described to
  them as "List all clinicians", "List all appointments" and "Book an
  appointment". Adding clinicians and cancelling are not available to
  assistants.
- **The export job** above.

Clinicians and appointments must be kept safely, so nothing is lost when an
app restarts, and every one of these places sees the same clinicians and
appointments.
