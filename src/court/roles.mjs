export const REQUIRED_ROLES = Object.freeze(["monarch", "heir", "rival"]);
export const OPTIONAL_ROLES = Object.freeze([
  "lover", "spymaster", "high_priest", "master_of_coin", "foreign_envoy"
]);
export const ALL_ROLES = Object.freeze([...REQUIRED_ROLES, ...OPTIONAL_ROLES]);

export const ROLE_WIN_CONDITIONS = Object.freeze({
  monarch: "Die naturally after securing the successor you most recently named.",
  heir: "Survive and take the throne with legitimacy and at least two other council supporters.",
  rival: "Take the throne through crisis, the Heir's disqualification, or a council coalition.",
  lover: "Have your secret partner win while the affair stays hidden, or defect by marriage pact and help the Rival win.",
  spymaster: "Ensure the eventual sovereign has honored at least three favors owed to you.",
  high_priest: "Ensure the eventual sovereign was consecrated by you.",
  master_of_coin: "Accumulate at least two honored favor-debts, regardless of the sovereign.",
  foreign_envoy: "Ensure the eventual sovereign remains bound by treaty to your realm."
});

export function displayRole(role) {
  return role.split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}
