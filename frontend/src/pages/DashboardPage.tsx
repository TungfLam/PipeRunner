import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import FolderIcon from "@mui/icons-material/Folder";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { api } from "../api/client";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { Project } from "../types/domain";

interface ProjectFormState {
  _id?: string;
  name: string;
  description: string;
}

const emptyForm: ProjectFormState = { name: "", description: "" };

export function DashboardPage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ProjectFormState | null>(null);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: async () => (await api.get<{ projects: Project[] }>("/projects")).data.projects
  });

  const saveProject = useMutation({
    mutationFn: async (value: ProjectFormState) => {
      if (value._id) {
        return api.patch(`/projects/${value._id}`, value);
      }
      return api.post("/projects", value);
    },
    onSuccess: async () => {
      setForm(null);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    }
  });

  const deleteProject = useMutation({
    mutationFn: async (projectId: string) => api.delete(`/projects/${projectId}`),
    onSuccess: async () => {
      setProjectToDelete(null);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    }
  });

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            Projects
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Private workspaces for local workflow definitions and run history.
          </Typography>
        </Box>
        <Button startIcon={<AddIcon />} variant="contained" onClick={() => setForm(emptyForm)}>
          Project
        </Button>
      </Stack>

      <Paper sx={{ overflow: "hidden" }} elevation={1}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Description</TableCell>
              <TableCell>Updated</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(projectsQuery.data || []).map((project) => (
              <TableRow key={project._id} hover>
                <TableCell>
                  <Button component={RouterLink} to={`/projects/${project._id}`} startIcon={<FolderIcon />}>
                    {project.name}
                  </Button>
                </TableCell>
                <TableCell>{project.description}</TableCell>
                <TableCell>{new Date(project.updatedAt).toLocaleString()}</TableCell>
                <TableCell align="right">
                  <Tooltip title="Edit project">
                    <IconButton onClick={() => setForm(project)}>
                      <EditIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete project">
                    <IconButton color="error" onClick={() => setProjectToDelete(project)}>
                      <DeleteIcon />
                    </IconButton>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
            {!projectsQuery.isLoading && projectsQuery.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={4}>
                  <Typography variant="body2" color="text.secondary">
                    No projects yet.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>

      <Dialog open={Boolean(form)} onClose={() => setForm(null)} fullWidth maxWidth="sm">
        <DialogTitle>{form?._id ? "Edit Project" : "Create Project"}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label="Name"
              value={form?.name || ""}
              onChange={(event) => setForm((current) => ({ ...(current || emptyForm), name: event.target.value }))}
              fullWidth
            />
            <TextField
              label="Description"
              value={form?.description || ""}
              onChange={(event) =>
                setForm((current) => ({ ...(current || emptyForm), description: event.target.value }))
              }
              fullWidth
              multiline
              minRows={3}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setForm(null)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!form?.name || saveProject.isPending}
            onClick={() => form && saveProject.mutate(form)}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
      <ConfirmDialog
        open={Boolean(projectToDelete)}
        title="Delete Project"
        description={
          projectToDelete
            ? `Delete "${projectToDelete.name}"? Workflows and run history in this project will also be removed.`
            : ""
        }
        confirmLabel="Delete"
        loading={deleteProject.isPending}
        onCancel={() => setProjectToDelete(null)}
        onConfirm={() => projectToDelete && deleteProject.mutate(projectToDelete._id)}
      />
    </Stack>
  );
}
