// Calendar days as "YYYY-MM-DD" in this browser's time zone (the Album of the Day is a day on my calendar, not UTC's).

const pad = (n) => String(n).padStart(2, "0");

export const dayOf = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const addDays = (day, n) => {
  const date = new Date(`${day}T12:00:00`); // noon: a daylight-saving change can't move it to another day
  date.setDate(date.getDate() + n);
  return dayOf(date);
};

export const longDay = (day) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
