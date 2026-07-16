import express from "express";
import cors from "cors";

const app = express();

app.use(cors());

app.use(express.json());

app.post("/verify", async (req, res) => {

    const { txHash } = req.body;

    console.log(txHash);

    res.json({

        paid: false

    });

});

app.listen(3000, () => {

    console.log("Server running on port 3000");

});