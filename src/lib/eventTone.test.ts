import { describe, expect, it } from "vitest";
import { eventTone } from "./eventTone";

describe("eventTone", () => {
  it("treats events you organise as confirmed, whatever Graph says about your response", () => {
    expect(eventTone({ isOrganizer: true, response: "none" })).toBe("confirmed");
    expect(eventTone({ isOrganizer: true, response: "organizer" })).toBe("confirmed");
    expect(eventTone({ isOrganizer: true, response: "notResponded" })).toBe("confirmed");
  });

  it("personal appointments (response none) are confirmed", () => {
    expect(eventTone({ isOrganizer: false, response: "none" })).toBe("confirmed");
    expect(eventTone({ isOrganizer: false, response: null })).toBe("confirmed");
  });

  it("only unanswered invitations from others are pending", () => {
    expect(eventTone({ isOrganizer: false, response: "notResponded" })).toBe("pending");
    expect(eventTone({ isOrganizer: false, response: "accepted" })).toBe("confirmed");
    expect(eventTone({ isOrganizer: false, response: "tentativelyAccepted" })).toBe("tentative");
    expect(eventTone({ isOrganizer: false, response: "declined" })).toBe("declined");
  });
});
