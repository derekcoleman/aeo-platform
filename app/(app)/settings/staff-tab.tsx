import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { opsStaff } from "@/lib/app/queries";
import { StaffForm } from "./staff-form";

/** Settings → Staff: the internal staff list, a separate axis from customer memberships. */
export async function StaffTab() {
  const staff = await opsStaff();
  return (
    <Card>
      <CardHeader><CardTitle>Internal staff</CardTitle><CardDescription>A separate axis from customer memberships. Staff read every organisation and use the Ops console.</CardDescription></CardHeader>
      <CardContent className="grid gap-4">
        <Table>
          <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Name</TableHead><TableHead>Level</TableHead></TableRow></TableHeader>
          <TableBody>
            {staff.staff.map((s) => <TableRow key={s.user_id}><TableCell>{s.email}</TableCell><TableCell>{s.name ?? "—"}</TableCell><TableCell>{s.level}</TableCell></TableRow>)}
            {staff.bootstrap.filter((b) => !staff.staff.some((s) => s.email.toLowerCase() === b.email)).map((b) => <TableRow key={b.email}><TableCell>{b.email}</TableCell><TableCell className="text-muted-foreground">not signed in yet</TableCell><TableCell>{b.level}</TableCell></TableRow>)}
          </TableBody>
        </Table>
        <StaffForm />
      </CardContent>
    </Card>
  );
}
