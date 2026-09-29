# Sheet updates that go with this release

Code lives in GitHub. These changes live in the **Spartan Staff Ops** Google
Sheet in the Spartan account and have to be made there by hand. The app picks
them up within a minute.

## 1. Hours tab: start-time column
Type `Start` in cell **K1** (right after "Approved By"). Private lessons save
their start time there.

## 2. Schedule tab: youth classes
Delete the four old rows **Monday–Thursday, "Spartan Youth", 16:00–18:00**.

Then click the first empty cell in column A and paste this block (it's
tab-separated, so each value lands in its own column):

```
Monday	17:00	17:45	Spider Monkeys / Juniors Striking	Youth Striking		
Tuesday	17:00	17:45	Spider Monkeys / Juniors BJJ	Kids BJJ		
Tuesday	18:00	18:30	Leadership Team			
Wednesday	17:00	17:45	Spider Monkeys / Juniors Striking	Youth Striking		
Thursday	17:00	17:45	Spider Monkeys / Juniors BJJ	Kids BJJ		
Thursday	18:00	18:30	Leadership Team			
Saturday	10:00	11:00	Spartan Youth BJJ (4–12)	Kids BJJ		
Saturday	11:00	11:30	Leadership Team			
```

Coaches put their own names on classes with **I coach this class** in the app.

## 3. Staff tab: check roles
Confirm these rows exist (Name fills in when each person first signs in):

| Email | Role |
|---|---|
| dangerdave1914@gmail.com | Admin |
| sbgalabama@gmail.com | Admin, Approver |
| kacey@spartanfitnessmma.com | Approver |
| tylerstevens22@yahoo.com | Coach |
| melisano7@yahoo.com | Coach |
| acrutch18@gmail.com | Coach |
| conolleyc@gmail.com | Coach |

Add Noah and Drake with Role `Inventory` once their emails are in.

## 4. Apps Script bridge
Paste the new `Code.gs`, then Deploy → Manage deployments → pencil → Version:
**New version** → Deploy. The test page should say `spartan-build-4`. (This
lets the bridge create the Zen Planner Log tab with its headers.)
